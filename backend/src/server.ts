import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Chess } from 'chess.js';
import { StockfishService } from './services/StockfishService.js';

const app = express();
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS no permitido'));
    }
  }
}));

app.use(express.json());

const stockfish = new StockfishService();

// --- API KEY desde variable de entorno (nunca hardcodeada) ---
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
if (!GROQ_API_KEY) {
  console.warn('⚠️  GROQ_API_KEY no está definida. El coaching no funcionará.');
}

// --- PERSONALIDADES DE LOS COACHES ---
const personalities: Record<string, { name: string; style: string; tone: string }> = {
  magnus:  { name: "Magnus Carlsen",   style: "posicional y técnico",  tone: "seco y directo"        },
  hikaru:  { name: "Hikaru Nakamura",  style: "dinámico y rápido",     tone: "informal y energético" },
  fischer: { name: "Bobby Fischer",    style: "agresivo y clásico",    tone: "intenso y serio"       },
};

// --- HELPER: llamada a Groq ---
async function callGroq(messages: { role: string; content: string }[]): Promise<string> {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 400,
      messages,
    }),
  });

  const data: any = await response.json();

  if (data.error) {
    console.error('[Groq] Error:', data.error);
    throw new Error(data.error.message);
  }

  return data.choices?.[0]?.message?.content || '';
}

// --- HELPER: obtener FEN invertido para analizar amenazas del rival ---
// Simplemente analizamos la misma posición pero como si fuera turno del rival
function getRivalFen(fen: string): string | null {
  try {
    const parts = fen.split(' ');
    if (parts.length < 2) return null;
    // Cambiamos el turno: w→b o b→w
    parts[1] = parts[1] === 'w' ? 'b' : 'w';
    // Reseteamos el contador de medios movimientos para evitar problemas
    if (parts.length >= 5) parts[4] = '0';
    const rivalFen = parts.join(' ');
    // Validar que el FEN sea legal con chess.js
    const test = new Chess(rivalFen);
    // Si el rey del jugador actual está en jaque en la posición "como si fuera su turno"
    // significa que esta posición no es válida para analizar — devolvemos null
    if (test.isCheck()) return null;
    return rivalFen;
  } catch {
    return null;
  }
}

// --- ENDPOINT 1: Análisis automático tras cada movimiento ---
app.post('/analyze', async (req, res) => {
  const { fen, coachId } = req.body;
  try {
    // Análisis propio (tus mejores jugadas)
    const suggestions = await stockfish.analyze(fen);

    // Análisis del rival (sus mejores amenazas desde la misma posición)
    let threatSuggestions: typeof suggestions = [];
    const rivalFen = getRivalFen(fen);
    if (rivalFen) {
      try {
        threatSuggestions = await stockfish.analyze(rivalFen, 10);
      } catch (e) {
        console.warn('[analyze] No se pudieron calcular amenazas del rival:', e);
      }
    }

    const coach = personalities[coachId] || personalities.magnus;

    // Prompt mejorado: explica TU mejor jugada + la intención del rival
    const bestOwnMove   = suggestions[0]?.san   ?? 'sin datos';
    const bestThreat    = threatSuggestions[0]?.san ?? null;
    const rivalContext  = bestThreat
      ? `La mejor respuesta del rival sería ${bestThreat} — explicá brevemente cuál es su amenaza o idea detrás de esa jugada (en 1 frase).`
      : '';

    const explanation = await callGroq([{
      role: 'user',
      content: `Eres el coach de ajedrez ${coach.name}. Tu estilo es ${coach.style} y tu tono es ${coach.tone}.

Posición actual (FEN): ${fen}
Tus mejores jugadas: ${suggestions.map(s => s.san).join(', ')}
${bestThreat ? `Mejor jugada disponible para el rival: ${bestThreat}` : ''}

Respondé en español con exactamente este formato en 3 frases:
1. Explicá cuál es la IDEA PRINCIPAL detrás de la mejor jugada (${bestOwnMove}): qué problema resuelve, qué ventaja genera, o qué plan activa.
2. ${rivalContext || 'Mencioná brevemente qué aspecto de la posición es más crítico ahora.'}
3. Un consejo táctico o posicional concreto para esta posición, con tu estilo característico.

No menciones números de evaluación. Sé específico con los nombres de las piezas y casillas.`,
    }]);

    res.json({
      suggestions,
      threatSuggestions,
      explanation: explanation || 'El coach está analizando...',
    });
  } catch (error: any) {
    console.error('[/analyze] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- ENDPOINT 2: Chat interactivo con memoria ---
app.post('/chat', async (req, res) => {
  const { fen, question, coachId, lastAnalysisSAN, history } = req.body;
  const coach = personalities[coachId] || personalities.magnus;

  const chatHistory = (history || [])
    .slice(0, -1)
    .filter((msg: { role: string; text: string }) => msg.text?.trim())
    .map((msg: { role: string; text: string }) => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.text,
    }));

  const messages = [
    {
      role: 'system',
      content: `Eres el coach de ajedrez ${coach.name}. Estilo: ${coach.style}. Tono: ${coach.tone}.
Posición actual (FEN): ${fen}.
Mejores jugadas sugeridas para el jugador: ${lastAnalysisSAN || 'no disponibles'}.
Respondé siempre en español, de forma breve y con tu personalidad característica.
Cuando expliques jugadas, mencioná la pieza y la casilla de destino para que sea claro.`,
    },
    ...chatHistory,
    { role: 'user', content: question },
  ];

  console.log(`[/chat] coach=${coachId} historial=${chatHistory.length} mensajes`);

  try {
    const answer = await callGroq(messages);
    res.json({ answer: answer || 'No pude entender la pregunta.' });
  } catch (error: any) {
    console.error('[/chat] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- ENDPOINT 3: Movimiento de la computadora ---
app.post('/move', async (req, res) => {
  const { fen, level } = req.body;

  const depthMap: Record<number, number> = {
    1: 1, 2: 2, 3: 4, 4: 6, 5: 8, 6: 10, 7: 12, 8: 15
  };
  const lvl = Math.max(1, Math.min(8, parseInt(level) || 4));
  const depth = depthMap[lvl];

  try {
    if (lvl <= 2 && Math.random() < 0.5) {
      const g = new Chess(fen);
      const moves = g.moves({ verbose: true });
      if (moves.length > 0) {
        const m = moves[Math.floor(Math.random() * moves.length)];
        return res.json({ move: m.from + m.to + (m.promotion ?? '') });
      }
    }

    const move = await stockfish.getBestMove(fen, depth);
    if (!move) return res.status(400).json({ error: 'No hay movimiento disponible' });
    res.json({ move });
  } catch (error: any) {
    console.error('[/move] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- SERVIDOR ---
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
app.listen(PORT, () => console.log(`🚀 Backend corriendo en puerto ${PORT}`));

process.on('SIGINT',  () => { stockfish.shutdown(); process.exit(0); });
process.on('SIGTERM', () => { stockfish.shutdown(); process.exit(0); });