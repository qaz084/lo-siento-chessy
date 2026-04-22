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
  ChevronDown,
  RotateCcw,
  Eye,
  EyeOff,
  Send,
  Loader2,
  Target,
  Download,
  Copy,
  Settings,
  X,
} from 'lucide-react';

// ─── TIPOS ────────────────────────────────────────────────────────────────────
interface Suggestion { uci: string; san: string; score: string; }
interface AnalysisResponse { suggestions: Suggestion[]; explanation: string; }
interface ChatMessage { role: 'user' | 'coach'; text: string; }
type BoardArrow = [Square, Square];

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const RAW_API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

function sanitizeApiUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'http://localhost:3000';
    return parsed.origin + parsed.pathname.replace(/\/$/, '');
  } catch { return 'http://localhost:3000'; }
}

const API_URL = sanitizeApiUrl(RAW_API_URL);

const COACHES: Record<string, { label: string; avatar: string }> = {
  magnus:  { label: 'Magnus Carlsen',  avatar: 'MC' },
  hikaru:  { label: 'Hikaru Nakamura', avatar: 'HN' },
  fischer: { label: 'Bobby Fischer',   avatar: 'BF' },
};

// ─── UTILIDAD: exportar PGN ───────────────────────────────────────────────────
function buildPGN(fenHistory: string[]): string {
  const game = new Chess();
  for (let i = 1; i < fenHistory.length; i++) {
    const prev  = new Chess(fenHistory[i - 1]);
    const curr  = new Chess(fenHistory[i]);
    const moves = prev.moves({ verbose: true });
    const found = moves.find((m) => {
      const tmp = new Chess(fenHistory[i - 1]);
      tmp.move(m);
      return tmp.fen().split(' ')[0] === curr.fen().split(' ')[0];
    });
    if (found) game.move(found);
  }
  return game.pgn();
}

// ─── HOOK: AbortController fetch ────────────────────────────────────────────
function useAbortFetch() {
  const controllerRef = useRef<AbortController | null>(null);
  const abortableFetch = useCallback(async (url: string, options: RequestInit) => {
    controllerRef.current?.abort();
    controllerRef.current = new AbortController();
    return fetch(url, { ...options, signal: controllerRef.current.signal });
  }, []);
  useEffect(() => () => controllerRef.current?.abort(), []);
  return abortableFetch;
}

// ─── COMPONENTE: Sección colapsable ──────────────────────────────────────────
const Collapsible: React.FC<{
  title: React.ReactNode;
  defaultOpen?: boolean;
  accentBorder?: boolean;
  children: React.ReactNode;
}> = ({ title, defaultOpen = true, accentBorder = false, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={`collapsible${accentBorder ? ' collapsible--accent' : ''}`}>
      <button
        className="collapsible__trigger"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(v => !v)}
      >
        <span className="collapsible__title">{title}</span>
        <ChevronDown size={14} aria-hidden="true"
          className={`collapsible__chevron${open ? ' collapsible__chevron--open' : ''}`} />
      </button>
      <div id={id} className={`collapsible__body${open ? ' collapsible__body--open' : ''}`} aria-hidden={!open}>
        {children}
      </div>
    </div>
  );
};

// ─── COMPONENTE: Barra de evaluación ─────────────────────────────────────────
const EvalBar: React.FC<{ score: string; loading: boolean }> = ({ score, loading }) => {
  const n = parseFloat(score) || 0;
  const whitePct = Math.max(5, Math.min(95, 50 - n * 5));
  return (
    <div role="meter" aria-label={`Evaluación: ${score}`}
      aria-valuenow={n} aria-valuemin={-10} aria-valuemax={10} className="eval-bar">
      <div className="eval-bar__fill"
        style={{ height: `${whitePct}%`, opacity: loading ? 0.5 : 1 }} aria-hidden="true" />
      <span className="eval-bar__label" aria-hidden="true">{loading ? '…' : score}</span>
    </div>
  );
};

// ─── COMPONENTE: Fila de sugerencia ──────────────────────────────────────────
const SuggestionRow: React.FC<{ suggestion: Suggestion; rank: number }> = ({ suggestion, rank }) => (
  <div className="suggestion-row" role="listitem">
    <span className="suggestion-row__rank" aria-label={`Opción ${rank}`}>{rank}</span>
    <span className="suggestion-row__san">{suggestion.san}</span>
    <span className="suggestion-row__score">{suggestion.score}</span>
  </div>
);

// ─── COMPONENTE: Toggle de ayudas ────────────────────────────────────────────
const ArrowToggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void }> = ({ checked, onChange }) => {
  const id = useId();
  return (
    <div className="arrow-toggle">
      <label htmlFor={id} className="arrow-toggle__label">
        {checked ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
        <span>Ayudas visuales</span>
      </label>
      <button id={id} role="switch" aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`arrow-toggle__switch${checked ? ' arrow-toggle__switch--on' : ''}`}>
        <span className="arrow-toggle__thumb" />
        <span className="sr-only">{checked ? 'Desactivar' : 'Activar'} ayudas visuales</span>
      </button>
    </div>
  );
};

// ─── COMPONENTE: Modal de exportación ────────────────────────────────────────
const ExportModal: React.FC<{ pgn: string; fen: string; onClose: () => void }> = ({ pgn, fen, onClose }) => {
  const [copied, setCopied] = useState<'pgn' | 'fen' | null>(null);

  const copy = (text: string, type: 'pgn' | 'fen') => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(type);
      setTimeout(() => setCopied(null), 1800);
    });
  };

  const downloadPGN = () => {
    const blob = new Blob([pgn], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `partida-${Date.now()}.pgn`; a.click();
    URL.revokeObjectURL(url);
  };

  // Cerrar con Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Exportar partida"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal__header">
          <span className="modal__title">Exportar partida</span>
          <button className="modal__close" onClick={onClose} aria-label="Cerrar modal">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="modal__body">
          <p className="modal__label">PGN</p>
          <pre className="modal__pre">{pgn || '(partida vacía — jugá al menos un movimiento)'}</pre>
          <div className="modal__actions">
            <button className="btn-secondary" onClick={() => copy(pgn, 'pgn')}>
              <Copy size={13} aria-hidden="true" />
              {copied === 'pgn' ? '¡Copiado!' : 'Copiar'}
            </button>
            <button className="btn-secondary" onClick={downloadPGN}>
              <Download size={13} aria-hidden="true" />
              Descargar .pgn
            </button>
          </div>

          <p className="modal__label" style={{ marginTop: '1rem' }}>FEN actual</p>
          <pre className="modal__pre modal__pre--fen">{fen}</pre>
          <div className="modal__actions">
            <button className="btn-secondary" onClick={() => copy(fen, 'fen')}>
              <Copy size={13} aria-hidden="true" />
              {copied === 'fen' ? '¡Copiado!' : 'Copiar FEN'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── COMPONENTE: Dropdown de configuración en el header ──────────────────────
const HeaderSettings: React.FC<{
  coachId: string;
  onCoachChange: (id: string) => void;
  showArrows: boolean;
  onArrowsChange: (v: boolean) => void;
}> = ({ coachId, onCoachChange, showArrows, onArrowsChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);

  const coachInfo = COACHES[coachId] ?? COACHES.magnus;

  return (
    <div ref={ref} className="header-settings">
      <button
        className="header-settings__trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Configuración — entrenador: ${coachInfo.label}`}
        onClick={() => setOpen(v => !v)}
      >
        <span className="coach-avatar" aria-hidden="true">{coachInfo.avatar}</span>
        <span className="header-settings__name">{coachInfo.label}</span>
        <Settings size={13} aria-hidden="true" className="header-settings__gear" />
      </button>

      {open && (
        <div className="header-settings__dropdown" role="menu" aria-label="Opciones del entrenador">
          <p className="header-settings__section-label">Entrenador</p>
          {Object.entries(COACHES).map(([id, { label, avatar }]) => (
            <button key={id} role="menuitem"
              className={`header-settings__option${coachId === id ? ' header-settings__option--active' : ''}`}
              onClick={() => { onCoachChange(id); setOpen(false); }}>
              <span className="coach-avatar coach-avatar--sm" aria-hidden="true">{avatar}</span>
              {label}
            </button>
          ))}
          <div className="header-settings__divider" />
          <div className="header-settings__toggle-row">
            <ArrowToggle checked={showArrows} onChange={onArrowsChange} />
          </div>
        </div>
      )}
    </div>
  );
};

// ─── COMPONENTE: Chat ────────────────────────────────────────────────────────
const ChatPanel: React.FC<{
  log: ChatMessage[]; value: string;
  onChange: (v: string) => void; onSend: () => void; loading: boolean;
}> = ({ log, value, onChange, onSend, loading }) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const regionId  = useId();

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [log]);

  return (
    <section className="chat-panel" aria-label="Chat con el entrenador">
      <header className="chat-panel__header">
        <span className="chat-panel__title">Chat</span>
      </header>
      <div id={regionId} role="log" aria-live="polite" className="chat-panel__log">
        {log.length === 0 && (
          <p className="chat-panel__empty">Hacé una pregunta sobre la posición actual.</p>
        )}
        {log.map((msg, i) => (
          <div key={i} className={`chat-bubble chat-bubble--${msg.role}`}>
            <p className="chat-bubble__text">{msg.text}</p>
          </div>
        ))}
        <div ref={bottomRef} aria-hidden="true" />
      </div>
      <div className="chat-panel__input-row">
        <label htmlFor="chat-input" className="sr-only">Pregunta al entrenador</label>
        <input id="chat-input" type="text" value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
          placeholder="Preguntá algo…" disabled={loading}
          autoComplete="off" spellCheck={false} maxLength={500}
          className="chat-panel__input" aria-label="Mensaje para el entrenador" />
        <button onClick={onSend} disabled={loading || !value.trim()}
          className="chat-panel__send" aria-label="Enviar mensaje">
          {loading ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
        </button>
      </div>
    </section>
  );
};

// ─── APP PRINCIPAL ────────────────────────────────────────────────────────────
const App: React.FC = () => {
  const [game, setGame]               = useState(() => new Chess());
  const gameRef                       = useRef(game);
  const [history, setHistory]         = useState<string[]>([new Chess().fen()]);
  const historyRef                    = useRef<string[]>([new Chess().fen()]);
  const [currentStep, setCurrentStep] = useState(0);
  const currentStepRef                = useRef(0);

  const [coachId, setCoachId]         = useState('magnus');
  const [analysis, setAnalysis]       = useState<AnalysisResponse | null>(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [showArrows, setShowArrows]   = useState(true);

  const [chatLog, setChatLog]         = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput]     = useState('');
  const [loadingChat, setLoadingChat] = useState(false);
  const [showExport, setShowExport]   = useState(false);

  const abortableFetch = useAbortFetch();

  const fetchAnalysis = useCallback(async (fen: string, coach: string) => {
    setLoadingAnalysis(true);
    try {
      const res = await abortableFetch(`${API_URL}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen, coachId: coach }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAnalysis(await res.json());
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') console.error('[análisis]', err.message);
    } finally {
      setLoadingAnalysis(false);
    }
  }, [abortableFetch]);

  useEffect(() => { fetchAnalysis(gameRef.current.fen(), coachId); /* eslint-disable-next-line */ }, []);

  const arrows = useMemo<BoardArrow[]>(() => {
    if (!showArrows || !analysis?.suggestions) return [];
    return analysis.suggestions.map(s => [s.uci.slice(0, 2) as Square, s.uci.slice(2, 4) as Square]);
  }, [analysis, showArrows]);

  const onDrop = useCallback((from: string, to: string): boolean => {
    try {
      const copy = new Chess(gameRef.current.fen());
      const move: Move | null = copy.move({ from: from as Square, to: to as Square, promotion: 'q' });
      if (!move) return false;
      const newFen  = copy.fen();
      const newHist = historyRef.current.slice(0, currentStepRef.current + 1);
      newHist.push(newFen);
      const newStep = newHist.length - 1;
      gameRef.current = copy; historyRef.current = newHist; currentStepRef.current = newStep;
      setGame(copy); setHistory(newHist); setCurrentStep(newStep);
      fetchAnalysis(newFen, coachId);
      return true;
    } catch { return false; }
  }, [coachId, fetchAnalysis]);

  const navigate = useCallback((dir: number) => {
    const next = currentStepRef.current + dir;
    if (next < 0 || next >= historyRef.current.length) return;
    const fen = historyRef.current[next];
    const ng  = new Chess(fen);
    gameRef.current = ng; currentStepRef.current = next;
    setGame(ng); setCurrentStep(next);
    fetchAnalysis(fen, coachId);
  }, [coachId, fetchAnalysis]);

  const handleCoachChange = useCallback((id: string) => {
    setCoachId(id);
    fetchAnalysis(gameRef.current.fen(), id);
  }, [fetchAnalysis]);

  const sendChat = useCallback(async () => {
    const q = chatInput.trim();
    if (!q || loadingChat) return;
    const safeQ = q.slice(0, 500).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    if (!safeQ) return;
    const updated: ChatMessage[] = [...chatLog, { role: 'user', text: safeQ }];
    setChatLog(updated); setChatInput(''); setLoadingChat(true);
    try {
      const res = await fetch(`${API_URL}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen: gameRef.current.fen(), question: safeQ, history: updated,
          coachId, lastAnalysisSAN: analysis?.suggestions.map(s => s.san).join(', ') ?? '' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const answer = typeof data.answer === 'string' && data.answer.length > 0 ? data.answer : 'El entrenador no respondió.';
      setChatLog(prev => [...prev, { role: 'coach', text: answer }]);
    } catch (err: unknown) {
      setChatLog(prev => [...prev, { role: 'coach', text: err instanceof Error ? err.message : 'Error de conexión.' }]);
    } finally { setLoadingChat(false); }
  }, [chatInput, chatLog, coachId, analysis, loadingChat]);

  const resetGame = () => {
    const fresh = new Chess();
    gameRef.current = fresh; historyRef.current = [fresh.fen()]; currentStepRef.current = 0;
    setGame(fresh); setHistory([fresh.fen()]); setCurrentStep(0);
    setAnalysis(null); setChatLog([]);
    fetchAnalysis(fresh.fen(), coachId);
  };

  const evalScore = analysis?.suggestions[0]?.score ?? '0.0';
  const pgn       = buildPGN(historyRef.current);

  return (
    <>
      <a href="#main-content" className="skip-link">Saltar al contenido principal</a>

      <div className="app-shell">
        <header className="app-header" role="banner">
          <Target size={18} aria-hidden="true" className="app-header__icon" />
          <h1 className="app-header__title">Chess Coach</h1>
          <HeaderSettings
            coachId={coachId}
            onCoachChange={handleCoachChange}
            showArrows={showArrows}
            onArrowsChange={setShowArrows}
          />
        </header>

        <main id="main-content" className="app-main">
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

          <nav className="board-controls" aria-label="Controles del tablero">
            <button onClick={() => navigate(-1)} disabled={currentStep === 0}
              className="btn-icon" aria-label="Jugada anterior">
              <ChevronLeft size={20} aria-hidden="true" />
            </button>
            <span className="board-controls__step" aria-live="polite" aria-atomic="true">
              {currentStep > 0 ? `Jugada ${currentStep}` : 'Inicio'}
            </span>
            <button onClick={() => navigate(1)} disabled={currentStep === history.length - 1}
              className="btn-icon" aria-label="Jugada siguiente">
              <ChevronRight size={20} aria-hidden="true" />
            </button>
            <button onClick={() => setShowExport(true)}
              className="btn-icon" aria-label="Exportar partida" title="Exportar PGN / FEN">
              <Download size={18} aria-hidden="true" />
            </button>
            <button onClick={resetGame}
              className="btn-icon btn-icon--danger" aria-label="Reiniciar partida">
              <RotateCcw size={18} aria-hidden="true" />
            </button>
          </nav>

          <aside className="side-panel" aria-label="Panel del entrenador">
            <Collapsible
              defaultOpen={false}
              title={
                loadingAnalysis
                  ? <><Loader2 size={12} className="spin" aria-hidden="true" /><span style={{marginLeft:6}}>Analizando…</span></>
                  : 'Mejores jugadas'
              }
            >
              <div role="list" aria-label="Jugadas sugeridas" aria-busy={loadingAnalysis}>
                {analysis?.suggestions.length ? (
                  analysis.suggestions.map((s, i) => <SuggestionRow key={s.uci} suggestion={s} rank={i + 1} />)
                ) : (
                  <p className="panel-empty">{loadingAnalysis ? '' : 'Sin datos todavía.'}</p>
                )}
              </div>
            </Collapsible>

            <Collapsible title="Consejo del entrenador" defaultOpen={true} accentBorder={true}>
              <p className="panel-body" aria-live="polite" aria-atomic="true">
                {loadingAnalysis
                  ? 'Analizando posición…'
                  : analysis?.explanation || 'Realizá un movimiento para recibir feedback.'}
              </p>
            </Collapsible>

            <ChatPanel
              log={chatLog} value={chatInput}
              onChange={setChatInput} onSend={sendChat} loading={loadingChat}
            />
          </aside>
        </main>
      </div>

      {showExport && (
        <ExportModal pgn={pgn} fen={game.fen()} onClose={() => setShowExport(false)} />
      )}
    </>
  );
};

export default App;