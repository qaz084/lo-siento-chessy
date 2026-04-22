import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useId,
} from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess, type Square, type Move } from 'chess.js';
import {
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Eye,
  EyeOff,
  Send,
  Loader2,
  Target,
} from 'lucide-react';

// ─── TIPOS ────────────────────────────────────────────────────────────────────
interface Suggestion {
  uci: string;
  san: string;
  score: string;
}

interface AnalysisResponse {
  suggestions: Suggestion[];
  explanation: string;
}

interface ChatMessage {
  role: 'user' | 'coach';
  text: string;
}

type BoardArrow = [Square, Square];

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
// SEGURIDAD: La URL se inyecta solo por variable de entorno; nunca se hardcodea
// un origen externo sin validar.
const RAW_API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

/**
 * Sanitiza la URL de la API: solo se permiten esquemas http/https y se elimina
 * cualquier trailing slash para evitar path-traversal en las llamadas.
 */
function sanitizeApiUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.error('[security] VITE_API_URL tiene un esquema no permitido.');
      return 'http://localhost:3000';
    }
    return parsed.origin + parsed.pathname.replace(/\/$/, '');
  } catch {
    return 'http://localhost:3000';
  }
}

const API_URL = sanitizeApiUrl(RAW_API_URL);

const COACHES: Record<string, { label: string; avatar: string }> = {
  magnus:  { label: 'Magnus Carlsen',  avatar: 'MC' },
  hikaru:  { label: 'Hikaru Nakamura', avatar: 'HN' },
  fischer: { label: 'Bobby Fischer',   avatar: 'BF' },
};

// ─── HOOK: fetch con AbortController ─────────────────────────────────────────
function useAbortFetch() {
  const controllerRef = useRef<AbortController | null>(null);

  const abortableFetch = useCallback(
    async (url: string, options: RequestInit): Promise<Response> => {
      controllerRef.current?.abort();
      controllerRef.current = new AbortController();
      return fetch(url, { ...options, signal: controllerRef.current.signal });
    },
    []
  );

  useEffect(() => () => controllerRef.current?.abort(), []);
  return abortableFetch;
}

// ─── BARRA DE EVALUACIÓN ──────────────────────────────────────────────────────
const EvalBar: React.FC<{ score: string; loading: boolean }> = ({ score, loading }) => {
  const numericScore = parseFloat(score) || 0;
  // 50 % neutro; cada peon = 5 pp (cap ±10 pawns)
  const whitePct = Math.max(5, Math.min(95, 50 - numericScore * 5));

  return (
    <div
      role="meter"
      aria-label={`Evaluación de la posición: ${score}`}
      aria-valuenow={numericScore}
      aria-valuemin={-10}
      aria-valuemax={10}
      className="eval-bar"
    >
      <div
        className="eval-bar__fill"
        style={{ height: `${whitePct}%`, opacity: loading ? 0.5 : 1 }}
        aria-hidden="true"
      />
      <span className="eval-bar__label" aria-hidden="true">
        {loading ? '…' : score}
      </span>
    </div>
  );
};

// ─── SUGERENCIA ───────────────────────────────────────────────────────────────
const SuggestionRow: React.FC<{ suggestion: Suggestion; rank: number }> = ({
  suggestion,
  rank,
}) => (
  <div className="suggestion-row" role="listitem">
    <span className="suggestion-row__rank" aria-label={`Opción ${rank}`}>
      {rank}
    </span>
    <span className="suggestion-row__san">{suggestion.san}</span>
    <span className="suggestion-row__score" aria-label={`Evaluación ${suggestion.score}`}>
      {suggestion.score}
    </span>
  </div>
);

// ─── TOGGLE DE AYUDAS ────────────────────────────────────────────────────────
const ArrowToggle: React.FC<{
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ checked, onChange }) => {
  const id = useId();
  return (
    <div className="arrow-toggle">
      <label htmlFor={id} className="arrow-toggle__label">
        {checked ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
        <span>Ayudas visuales</span>
      </label>
      <button
        id={id}
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`arrow-toggle__switch ${checked ? 'arrow-toggle__switch--on' : ''}`}
      >
        <span className="arrow-toggle__thumb" />
        <span className="sr-only">{checked ? 'Desactivar ayudas visuales' : 'Activar ayudas visuales'}</span>
      </button>
    </div>
  );
};

// ─── CHAT ─────────────────────────────────────────────────────────────────────
const ChatPanel: React.FC<{
  log: ChatMessage[];
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  loading: boolean;
}> = ({ log, value, onChange, onSend, loading }) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const regionId = useId();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <section className="chat-panel" aria-label="Chat con el entrenador">
      <header className="chat-panel__header">
        <span className="chat-panel__title">Chat</span>
      </header>

      <div
        id={regionId}
        role="log"
        aria-live="polite"
        aria-label="Historial de mensajes"
        className="chat-panel__log"
      >
        {log.length === 0 && (
          <p className="chat-panel__empty">
            Hacé una pregunta sobre la posición actual.
          </p>
        )}
        {log.map((msg, i) => (
          <div
            key={i}
            className={`chat-bubble chat-bubble--${msg.role}`}
          >
            <p className="chat-bubble__text">{msg.text}</p>
          </div>
        ))}
        <div ref={bottomRef} aria-hidden="true" />
      </div>

      <div className="chat-panel__input-row">
        <label htmlFor="chat-input" className="sr-only">
          Pregunta al entrenador
        </label>
        <input
          ref={inputRef}
          id="chat-input"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Preguntá algo…"
          disabled={loading}
          autoComplete="off"
          spellCheck={false}
          maxLength={500}
          className="chat-panel__input"
          aria-label="Mensaje para el entrenador"
        />
        <button
          onClick={onSend}
          disabled={loading || !value.trim()}
          className="chat-panel__send"
          aria-label="Enviar mensaje"
        >
          {loading ? (
            <Loader2 size={16} className="spin" aria-hidden="true" />
          ) : (
            <Send size={16} aria-hidden="true" />
          )}
        </button>
      </div>
    </section>
  );
};

// ─── APP PRINCIPAL ────────────────────────────────────────────────────────────
const App: React.FC = () => {
  // Juego
  const [game, setGame]           = useState(() => new Chess());
  const gameRef                   = useRef(game);
  const [history, setHistory]     = useState<string[]>([new Chess().fen()]);
  const historyRef                = useRef<string[]>([new Chess().fen()]);
  const [currentStep, setCurrentStep] = useState(0);
  const currentStepRef            = useRef(0);

  // Config
  const [coachId, setCoachId]     = useState<string>('magnus');
  const [analysis, setAnalysis]   = useState<AnalysisResponse | null>(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [showArrows, setShowArrows] = useState(true);

  // Chat
  const [chatLog, setChatLog]     = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [loadingChat, setLoadingChat] = useState(false);

  const abortableFetch = useAbortFetch();

  // ── Análisis ────────────────────────────────────────────────────────────────
  const fetchAnalysis = useCallback(
    async (fen: string, coach: string) => {
      setLoadingAnalysis(true);
      try {
        const res = await abortableFetch(`${API_URL}/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fen, coachId: coach }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: AnalysisResponse = await res.json();
        setAnalysis(data);
      } catch (err: unknown) {
        if (err instanceof Error && err.name !== 'AbortError') {
          console.error('[análisis]', err.message);
        }
      } finally {
        setLoadingAnalysis(false);
      }
    },
    [abortableFetch]
  );

  useEffect(() => {
    fetchAnalysis(gameRef.current.fen(), coachId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Flechas ─────────────────────────────────────────────────────────────────
  const arrows = useMemo<BoardArrow[]>(() => {
    if (!showArrows || !analysis?.suggestions) return [];
    return analysis.suggestions.map((s) => [
      s.uci.slice(0, 2) as Square,
      s.uci.slice(2, 4) as Square,
    ]);
  }, [analysis, showArrows]);

  // ── Movimiento ──────────────────────────────────────────────────────────────
  const onDrop = useCallback(
    (from: string, to: string): boolean => {
      try {
        const copy = new Chess(gameRef.current.fen());
        const move: Move | null = copy.move({
          from: from as Square,
          to: to as Square,
          promotion: 'q',
        });
        if (!move) return false;

        const newFen  = copy.fen();
        const newHist = historyRef.current.slice(0, currentStepRef.current + 1);
        newHist.push(newFen);
        const newStep = newHist.length - 1;

        gameRef.current    = copy;
        historyRef.current = newHist;
        currentStepRef.current = newStep;

        setGame(copy);
        setHistory(newHist);
        setCurrentStep(newStep);
        fetchAnalysis(newFen, coachId);
        return true;
      } catch {
        return false;
      }
    },
    [coachId, fetchAnalysis]
  );

  // ── Navegación ──────────────────────────────────────────────────────────────
  const navigate = useCallback(
    (dir: number) => {
      const next = currentStepRef.current + dir;
      if (next < 0 || next >= historyRef.current.length) return;
      const fen     = historyRef.current[next];
      const newGame = new Chess(fen);
      gameRef.current        = newGame;
      currentStepRef.current = next;
      setGame(newGame);
      setCurrentStep(next);
      fetchAnalysis(fen, coachId);
    },
    [coachId, fetchAnalysis]
  );

  // ── Coach change ────────────────────────────────────────────────────────────
  const handleCoachChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    setCoachId(id);
    fetchAnalysis(gameRef.current.fen(), id);
  };

  // ── Chat ────────────────────────────────────────────────────────────────────
  const sendChat = useCallback(async () => {
    const q = chatInput.trim();
    if (!q || loadingChat) return;

    // SEGURIDAD: longitud máxima y strip de caracteres de control
    const safeQ = q.slice(0, 500).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    if (!safeQ) return;

    const updated: ChatMessage[] = [...chatLog, { role: 'user', text: safeQ }];
    setChatLog(updated);
    setChatInput('');
    setLoadingChat(true);

    try {
      const res = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fen: gameRef.current.fen(),
          question: safeQ,
          history: updated,
          coachId,
          lastAnalysisSAN: analysis?.suggestions.map((s) => s.san).join(', ') ?? '',
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const answer =
        typeof data.answer === 'string' && data.answer.length > 0
          ? data.answer
          : 'El entrenador no respondió.';
      setChatLog((prev) => [...prev, { role: 'coach', text: answer }]);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Error de conexión.';
      setChatLog((prev) => [...prev, { role: 'coach', text: msg }]);
    } finally {
      setLoadingChat(false);
    }
  }, [chatInput, chatLog, coachId, analysis, loadingChat]);

  // ── Reset ───────────────────────────────────────────────────────────────────
  const resetGame = () => {
    const fresh = new Chess();
    gameRef.current        = fresh;
    historyRef.current     = [fresh.fen()];
    currentStepRef.current = 0;
    setGame(fresh);
    setHistory([fresh.fen()]);
    setCurrentStep(0);
    setAnalysis(null);
    setChatLog([]);
    fetchAnalysis(fresh.fen(), coachId);
  };

  const coachInfo = COACHES[coachId] ?? COACHES.magnus;
  const evalScore = analysis?.suggestions[0]?.score ?? '0.0';

  return (
    <>
      {/* Saltar navegación repetitiva (accesibilidad) */}
      <a href="#main-content" className="skip-link">
        Saltar al contenido principal
      </a>

      <div className="app-shell">
        {/* ── HEADER ──────────────────────────────────────── */}
        <header className="app-header" role="banner">
          <Target size={20} aria-hidden="true" className="app-header__icon" />
          <h1 className="app-header__title">Chess Coach</h1>
          <span className="app-header__coach" aria-label={`Entrenador: ${coachInfo.label}`}>
            <span className="coach-avatar" aria-hidden="true">
              {coachInfo.avatar}
            </span>
            {coachInfo.label}
          </span>
        </header>

        <main id="main-content" className="app-main">
          {/* ── TABLERO + BARRA ─────────────────────────── */}
          <section className="board-section" aria-label="Tablero de ajedrez">
            <EvalBar score={evalScore} loading={loadingAnalysis} />

            <div className="board-wrapper">
              <Chessboard
                position={game.fen()}
                onPieceDrop={onDrop}
                customArrows={arrows}
                customDarkSquareStyle={{ backgroundColor: '#334155' }}
                customLightSquareStyle={{ backgroundColor: '#94a3b8' }}
                animationDuration={180}
                arePremovesAllowed={false}
              />
            </div>
          </section>

          {/* ── CONTROLES DEL TABLERO ───────────────────── */}
          <nav
            className="board-controls"
            aria-label="Navegación de jugadas"
            role="navigation"
          >
            <button
              onClick={() => navigate(-1)}
              disabled={currentStep === 0}
              className="btn-icon"
              aria-label="Jugada anterior"
            >
              <ChevronLeft size={20} aria-hidden="true" />
            </button>

            <span className="board-controls__step" aria-live="polite" aria-atomic="true">
              {currentStep > 0
                ? `Jugada ${currentStep}`
                : 'Inicio'}
            </span>

            <button
              onClick={() => navigate(1)}
              disabled={currentStep === history.length - 1}
              className="btn-icon"
              aria-label="Jugada siguiente"
            >
              <ChevronRight size={20} aria-hidden="true" />
            </button>

            <button
              onClick={resetGame}
              className="btn-icon btn-icon--danger"
              aria-label="Reiniciar partida"
            >
              <RotateCcw size={18} aria-hidden="true" />
            </button>
          </nav>

          {/* ── PANEL LATERAL ───────────────────────────── */}
          <aside className="side-panel" aria-label="Panel del entrenador">

            {/* Selector de entrenador */}
            <section className="panel-card" aria-label="Selección de entrenador">
              <label htmlFor="coach-select" className="panel-card__label">
                Entrenador
              </label>
              <select
                id="coach-select"
                value={coachId}
                onChange={handleCoachChange}
                className="panel-card__select"
              >
                {Object.entries(COACHES).map(([id, { label }]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>

              <ArrowToggle checked={showArrows} onChange={setShowArrows} />
            </section>

            {/* Sugerencias */}
            <section
              className="panel-card"
              aria-label="Sugerencias de Stockfish"
              aria-busy={loadingAnalysis}
            >
              <h2 className="panel-card__heading">
                {loadingAnalysis ? (
                  <>
                    <Loader2 size={14} className="spin" aria-hidden="true" />
                    <span>Analizando…</span>
                  </>
                ) : (
                  'Mejores jugadas'
                )}
              </h2>
              <div role="list" aria-label="Jugadas sugeridas">
                {analysis?.suggestions.length ? (
                  analysis.suggestions.map((s, i) => (
                    <SuggestionRow key={s.uci} suggestion={s} rank={i + 1} />
                  ))
                ) : (
                  <p className="panel-card__empty">
                    {loadingAnalysis ? '' : 'Sin datos todavía.'}
                  </p>
                )}
              </div>
            </section>

            {/* Consejo del coach */}
            <section
              className="panel-card panel-card--accent"
              aria-label="Consejo del entrenador"
              aria-live="polite"
              aria-atomic="true"
            >
              <h2 className="panel-card__heading">Consejo</h2>
              <p className="panel-card__body">
                {loadingAnalysis
                  ? 'Analizando posición…'
                  : analysis?.explanation || 'Realizá un movimiento para recibir feedback.'}
              </p>
            </section>

            {/* Chat */}
            <ChatPanel
              log={chatLog}
              value={chatInput}
              onChange={setChatInput}
              onSend={sendChat}
              loading={loadingChat}
            />
          </aside>
        </main>
      </div>
    </>
  );
};

export default App;