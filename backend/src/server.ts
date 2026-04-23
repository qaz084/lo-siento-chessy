import 'dotenv/config';
import express from 'express';
import cors from 'cors';
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
      max_tokens: 300,
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

// --- ENDPOINT 1: Análisis automático tras cada movimiento ---
app.post('/analyze', async (req, res) => {
  const { fen, coachId } = req.body;
  try {
    const suggestions = await stockfish.analyze(fen);
    const coach = personalities[coachId] || personalities.magnus;

    const explanation = await callGroq([{
      role: 'user',
      content: `Eres el coach ${coach.name}. Tu tono es ${coach.tone}.
FEN actual: ${fen}.
Mejores jugadas: ${suggestions.map(s => s.san).join(', ')}.
Explica brevemente el plan del rival y por qué la mejor jugada es ${suggestions[0]?.san}.
Máximo 3 frases en español. No menciones números de evaluación.`,
    }]);

    res.json({
      suggestions,
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

  // El frontend manda role: 'user' | 'coach'
  // Groq espera role: 'user' | 'assistant'
  // Excluimos el último mensaje del historial porque es la pregunta actual (ya la mandamos aparte)
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
Mejores jugadas sugeridas: ${lastAnalysisSAN || 'no disponibles'}.
Responde siempre en español, de forma breve y con tu personalidad característica.`,
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

  // level 1-8 → depth progresivo con algo de aleatoriedad en niveles bajos
  const depthMap: Record<number, number> = {
    1: 1, 2: 2, 3: 4, 4: 6, 5: 8, 6: 10, 7: 12, 8: 15
  };
  const lvl = Math.max(1, Math.min(8, parseInt(level) || 4));
  const depth = depthMap[lvl];

  try {
    // En niveles bajos, a veces jugamos una jugada aleatoria válida
    if (lvl <= 2 && Math.random() < 0.5) {
      const { Chess } = await import('chess.js');
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

// Apagado limpio
process.on('SIGINT',  () => { stockfish.shutdown(); process.exit(0); });
process.on('SIGTERM', () => { stockfish.shutdown(); process.exit(0); });