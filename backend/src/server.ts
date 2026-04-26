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

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
if (!GROQ_API_KEY) {
  console.warn('⚠️  GROQ_API_KEY no está definida. El coaching no funcionará.');
}

// ─── PERSONALIDADES ────────────────────────────────────────────────────────────
const personalities: Record<string, {
  name: string;
  style: string;
  tone: string;
  focus: string;
  movePreference: string;
}> = {
  magnus: {
    name: "Magnus Carlsen",
    style: "posicional y técnico",
    tone: "seco, directo y confiado — como si la respuesta fuera obvia",
    focus: "control del centro, estructura de peones sólida, actividad de piezas a largo plazo y explotación de pequeñas ventajas posicionales",
    movePreference: "preferís jugadas que mejoran la coordinación de piezas o consolidan ventajas posicionales sutiles sobre ataques directos",
  },
  hikaru: {
    name: "Hikaru Nakamura",
    style: "dinámico, táctico y agresivo",
    tone: "informal, energético y directo — como si estuvieras transmitiendo en vivo",
    focus: "iniciativa, velocidad de desarrollo, presión constante sobre el rival y creación de complicaciones tácticas",
    movePreference: "preferís jugadas que generan presión inmediata, complican la posición o fuerzan errores del rival",
  },
  fischer: {
    name: "Bobby Fischer",
    style: "clásico, agresivo y dominante",
    tone: "intenso, seguro de sí mismo y algo arrogante — como si solo hubiera una jugada correcta",
    focus: "dominio del centro, ataques al rey, desarrollo rápido y destrucción de la estructura del rival",
    movePreference: "preferís jugadas que atacan directamente, generan debilidades en el campo rival o aceleran el desarrollo con presión",
  },
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function callGroq(
  messages: { role: string; content: string }[],
  maxTokens = 450,
): Promise<string> {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: maxTokens,
      messages,
    }),
  });

  const data: any = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// Reconstruye la línea de jugadas en SAN a partir del historial de FENs
function buildGameSAN(fenHistory: string[]): string {
  try {
    const game = new Chess();
    const sans: string[] = [];
    for (let i = 1; i < fenHistory.length; i++) {
      const prev  = new Chess(fenHistory[i - 1]);
      const curr  = new Chess(fenHistory[i]);
      const moves = prev.moves({ verbose: true });
      const found = moves.find(m => {
        const tmp = new Chess(fenHistory[i - 1]);
        tmp.move(m);
        return tmp.fen().split(' ')[0] === curr.fen().split(' ')[0];
      });
      if (found) {
        game.move(found);
        sans.push(found.san);
      }
    }
    let result = '';
    for (let i = 0; i < sans.length; i++) {
      if (i % 2 === 0) result += `${Math.floor(i / 2) + 1}.`;
      result += sans[i] + (i % 2 === 0 ? ' ' : ' ');
    }
    return result.trim() || '(ninguna jugada aún — posición inicial)';
  } catch {
    return '(historial no disponible)';
  }
}

// FEN con turno invertido para analizar amenazas del rival
function getRivalFen(fen: string): string | null {
  try {
    const parts = fen.split(' ');
    if (parts.length < 2) return null;
    parts[1] = parts[1] === 'w' ? 'b' : 'w';
    if (parts.length >= 5) parts[4] = '0';
    const rivalFen = parts.join(' ');
    const test = new Chess(rivalFen);
    if (test.isCheck()) return null;
    return rivalFen;
  } catch {
    return null;
  }
}

// System prompt base — mismo para /analyze y /chat (coherencia garantizada)
function buildCoachSystem(coachId: string, fen: string, gameSAN: string): string {
  const coach = personalities[coachId] ?? personalities.magnus;
  return `Sos el coach de ajedrez ${coach.name}. Tu estilo de juego es ${coach.style}.
Tu tono es ${coach.tone}.
Tu enfoque al analizar: ${coach.focus}.
Cuando sugerís jugadas, ${coach.movePreference}.

CONTEXTO DE LA PARTIDA:
- Jugadas hasta ahora: ${gameSAN}
- Posición actual (FEN): ${fen}

REGLAS ESTRICTAS — NUNCA las rompas:
1. JAMÁS sugerís jugadas de piezas que no están en la casilla de origen según el FEN actual. Siempre verificá el FEN antes de mencionar una casilla.
2. Sos el MISMO coach en el análisis del tablero y en el chat. Tus sugerencias son 100% coherentes.
3. Respondé SIEMPRE en español.
4. No uses números de evaluación numérica (centipawns, +0.3, etc.).
5. Nombrá piezas y casillas concretas cuando describas jugadas.`;
}

// ─── ENDPOINT 1: Análisis automático ──────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  const { fen, coachId, fenHistory = [] } = req.body;

  try {
    const coach = personalities[coachId] ?? personalities.magnus;

    const suggestions = await stockfish.analyze(fen);

    let threatSuggestions: typeof suggestions = [];
    const rivalFen = getRivalFen(fen);
    if (rivalFen) {
      try {
        threatSuggestions = await stockfish.analyze(rivalFen, 10);
      } catch (e) {
        console.warn('[analyze] Sin amenazas:', e);
      }
    }

    const gameSAN    = buildGameSAN(fenHistory);
    const bestMove   = suggestions[0]?.san ?? 'sin datos';
    const bestMoves  = suggestions.map(s => s.san).join(', ');
    const bestThreat = threatSuggestions[0]?.san ?? null;

    const explanation = await callGroq([
      {
        role: 'system',
        content: buildCoachSystem(coachId, fen, gameSAN),
      },
      {
        role: 'user',
        content: `Stockfish evaluó esta posición y sugiere (en orden de calidad técnica): ${bestMoves}.
${bestThreat ? `La mejor respuesta disponible para el rival sería: ${bestThreat}.` : ''}

Como ${coach.name}, con tu estilo ${coach.style}, respondé con EXACTAMENTE 3 frases:
1. La idea principal detrás de ${bestMove} desde TU filosofía — qué ventaja genera o qué plan activa.
2. ${bestThreat ? `Qué está planeando el rival con ${bestThreat} y por qué es relevante o peligroso.` : 'Cuál es el aspecto más crítico de esta posición ahora mismo.'}
3. Tu consejo característico: qué harías vos en esta posición y por qué.`,
      },
    ]);

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

// ─── ENDPOINT 2: Comentario del movimiento de la PC ───────────────────────────
app.post('/move-comment', async (req, res) => {
  const { fenBefore, fenAfter, moveSAN, coachId, fenHistory = [] } = req.body;

  if (!fenBefore || !fenAfter || !moveSAN) {
    return res.status(400).json({ error: 'Faltan parámetros' });
  }

  try {
    const coach    = personalities[coachId] ?? personalities.magnus;
    const gameSAN  = buildGameSAN(fenHistory);

    // Mejores respuestas disponibles para el jugador tras el movimiento de la PC
    const suggestionsAfter = await stockfish.analyze(fenAfter, 10);
    const bestReply = suggestionsAfter[0]?.san ?? null;

    const comment = await callGroq([
      {
        role: 'system',
        content: buildCoachSystem(coachId, fenAfter, gameSAN),
      },
      {
        role: 'user',
        content: `La computadora (tu rival) acaba de jugar ${moveSAN}.

Como ${coach.name}, respondé con EXACTAMENTE 2 frases:
1. Cuál es la idea o amenaza detrás de ${moveSAN}: qué está planeando el rival, qué debilidad explota o qué plan activa.
2. Qué deberías hacer ahora${bestReply ? ` — la mejor respuesta parece ser ${bestReply}` : ''} y por qué, con tu estilo característico.`,
      },
    ]);

    res.json({
      comment: comment || 'La computadora movió.',
      suggestionsAfter,
    });
  } catch (error: any) {
    console.error('[/move-comment] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── ENDPOINT 3: Chat interactivo ─────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const {
    fen,
    question,
    coachId,
    fenHistory = [],
    lastExplanation = '',
    lastSuggestions = [],
    lastThreatSuggestions = [],
  } = req.body;

  const coach   = personalities[coachId] ?? personalities.magnus;
  const gameSAN = buildGameSAN(fenHistory);

  const chatHistory = (req.body.history || [])
    .slice(0, -1)
    .filter((msg: { role: string; text: string }) => msg.text?.trim())
    .map((msg: { role: string; text: string }) => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.text,
    }));

  const suggestionsText = Array.isArray(lastSuggestions) && lastSuggestions.length > 0
    ? lastSuggestions.map((s: { san: string }, i: number) => `${i + 1}. ${s.san}`).join(', ')
    : 'no disponibles';

  const threatsText = Array.isArray(lastThreatSuggestions) && lastThreatSuggestions.length > 0
    ? lastThreatSuggestions.map((s: { san: string }, i: number) => `${i + 1}. ${s.san}`).join(', ')
    : null;

  // El system prompt incluye exactamente lo que el coach dijo en el panel —
  // así el chat sabe lo que "ya dijo" y no contradice ni repite sin contexto
  const systemPrompt =
    buildCoachSystem(coachId, fen, gameSAN) +
    `\n\nLO QUE VOS (${coach.name}) ACABÁS DE DECIRLE AL JUGADOR EN EL PANEL DE ANÁLISIS:
"${lastExplanation || '(aún no analizaste esta posición)'}"

Jugadas que recomendaste: ${suggestionsText}
${threatsText ? `Amenazas del rival que identificaste: ${threatsText}` : ''}

El jugador te hace una pregunta. Respondé siendo COHERENTE con lo que dijiste arriba.
Si pregunta sobre alguna jugada que sugeriste, explicala en detalle.
Si pregunta por qué sugeriste algo, justificalo desde tu filosofía de juego.
Máximo 4 frases. No repitas lo que ya dijiste textualmente — profundizá o ampliá.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
    { role: 'user', content: question },
  ];

  try {
    const answer = await callGroq(messages, 350);
    res.json({ answer: answer || 'No pude entender la pregunta.' });
  } catch (error: any) {
    console.error('[/chat] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── ENDPOINT 4: Movimiento de la computadora ─────────────────────────────────
app.post('/move', async (req, res) => {
  const { fen, level } = req.body;

  const depthMap: Record<number, number> = {
    1: 1, 2: 2, 3: 4, 4: 6, 5: 8, 6: 10, 7: 12, 8: 15
  };
  const lvl   = Math.max(1, Math.min(8, parseInt(level) || 4));
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

// ─── SERVIDOR ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
app.listen(PORT, () => console.log(`🚀 Backend corriendo en puerto ${PORT}`));

process.on('SIGINT',  () => { stockfish.shutdown(); process.exit(0); });
process.on('SIGTERM', () => { stockfish.shutdown(); process.exit(0); });