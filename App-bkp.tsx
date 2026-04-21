import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Chessboard } from 'react-chessboard';
// Importación de tipos estricta
import { Chess, type Square, type Move } from 'chess.js';
import { ChevronLeft, ChevronRight, MessageSquare, Brain, Target, RotateCcw, Eye, EyeOff } from 'lucide-react';

// --- DEFINICIÓN DE INTERFACES ---
interface Suggestion {
  uci: string;
  san: string;
  score: string;
}

interface AnalysisResponse {
  suggestions: Suggestion[];
  explanation: string;
}

// Tipo exacto que espera react-chessboard para las flechas
type BoardArrow = [Square, Square];

const API_URL = 'http://localhost:3000';

const App: React.FC = () => {
  // 1. ESTADO DEL JUEGO
  const [game, setGame] = useState(new Chess());
  const [history, setHistory] = useState<string[]>([new Chess().fen()]);
  const [currentStep, setCurrentStep] = useState(0);
  
  // 2. CONFIGURACIÓN Y ANÁLISIS
  const [coachId, setCoachId] = useState('magnus');
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [showArrows, setShowArrows] = useState(true);

  // 3. CHAT
  const [chatQuestion, setChatQuestion] = useState('');
  const [chatLog, setChatLog] = useState<{ role: string; text: string }[]>([]);

  // --- FUNCIÓN DE ANÁLISIS (Sincronizada) ---
  const fetchAnalysis = useCallback(async (fen: string, currentCoach: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen, coachId: currentCoach }),
      });
      const data = await res.json();
      setAnalysis(data);
    } catch (error) {
      console.error("Error al analizar:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  // --- SOLUCIÓN AL ERROR DE CASCADING RENDERS ---
  // Ejecutamos el análisis inicial solo UNA VEZ al montar el componente
  useEffect(() => {
    fetchAnalysis(game.fen(), coachId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); 

  // --- CÁLCULO DE FLECHAS (Memoizado para rendimiento) ---
  const arrows = useMemo(() => {
    if (showArrows && analysis?.suggestions) {
      return analysis.suggestions.map((s) => [
        s.uci.slice(0, 2) as Square, 
        s.uci.slice(2, 4) as Square
      ] as BoardArrow);
    }
    return [] as BoardArrow[];
  }, [analysis, showArrows]);

  // --- MANEJADORES DE EVENTOS (Análisis por eventos, no por efectos) ---

  const onDrop = (sourceSquare: string, targetSquare: string): boolean => {
    try {
      const gameCopy = new Chess(game.fen());
      const move: Move | null = gameCopy.move({
        from: sourceSquare as Square,
        to: targetSquare as Square,
        promotion: "q",
      });

      if (move) {
        setGame(gameCopy);
        const newFen = gameCopy.fen();
        const newHistory = history.slice(0, currentStep + 1);
        newHistory.push(newFen);
        setHistory(newHistory);
        setCurrentStep(newHistory.length - 1);

        // Disparar análisis inmediatamente tras el evento
        fetchAnalysis(newFen, coachId);
        return true;
      }
    } catch (error) {
      return false;
    }
    return false;
  };

  const handleCoachChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newCoach = e.target.value;
    setCoachId(newCoach);
    // Disparar análisis inmediatamente tras el cambio
    fetchAnalysis(game.fen(), newCoach);
  };

  const navigate = (dir: number) => {
    const nextStep = currentStep + dir;
    if (nextStep >= 0 && nextStep < history.length) {
      const nextFen = history[nextStep];
      setGame(new Chess(nextFen));
      setCurrentStep(nextStep);
      // Disparar análisis inmediatamente tras navegar
      fetchAnalysis(nextFen, coachId);
    }
  };

  const sendChat = async () => {
    if (!chatQuestion.trim()) return;
    const q = chatQuestion;
    setChatLog(prev => [...prev, { role: 'user', text: q }]);
    setChatQuestion('');

    try {
      const res = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          fen: game.fen(), 
          question: q, 
          coachId,
          lastAnalysisSAN: analysis?.suggestions.map(s => s.san).join(', ')
        }),
      });
      const data = await res.json();
      setChatLog(prev => [...prev, { role: 'coach', text: data.answer }]);
    } catch (e) {
      setChatLog(prev => [...prev, { role: 'coach', text: "Error de conexión." }]);
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-4 lg:p-8 flex flex-col items-center">
      <header className="mb-6 text-center">
        <h1 className="text-4xl font-light tracking-widest text-[#e2b96f] flex items-center gap-3">
          <Target size={32} /> CHESSY PRO
        </h1>
      </header>

      <div className="flex flex-col lg:flex-row gap-8 w-full justify-center items-start">
        
        {/* COLUMNA IZQUIERDA: BARRA Y TABLERO */}
        <div className="flex gap-4">
          <div className="w-6 h-[480px] bg-slate-800 rounded-full relative overflow-hidden border border-slate-700 shadow-xl">
            <div 
              className="absolute bottom-0 w-full bg-white transition-all duration-700"
              style={{ height: `${Math.max(0, Math.min(100, 50 - (parseFloat(analysis?.suggestions[0]?.score || "0") * 5)))}%` }}
            />
            <div className="absolute inset-0 flex items-center justify-center text-[10px] font-bold mix-blend-difference text-white">
              {analysis?.suggestions[0]?.score || "0.0"}
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="w-[480px] shadow-2xl rounded-lg overflow-hidden border-4 border-slate-800">
              <Chessboard 
                position={game.fen()} 
                onPieceDrop={onDrop}
                customArrows={arrows}
                customDarkSquareStyle={{ backgroundColor: '#1e293b' }}
                customLightSquareStyle={{ backgroundColor: '#334155' }}
                animationDuration={200}
              />
            </div>
            {/* Navegación */}
            <div className="flex gap-2">
              <button onClick={() => navigate(-1)} disabled={currentStep === 0} className="flex-1 bg-slate-800 p-3 rounded-lg hover:bg-slate-700 disabled:opacity-20 text-white transition-all shadow-md"><ChevronLeft className="mx-auto" /></button>
              <button onClick={() => navigate(1)} disabled={currentStep === history.length -1} className="flex-1 bg-slate-800 p-3 rounded-lg hover:bg-slate-700 disabled:opacity-20 text-white transition-all shadow-md"><ChevronRight className="mx-auto" /></button>
              <button onClick={() => window.location.reload()} className="bg-slate-800 p-3 rounded-lg hover:bg-slate-700 text-red-400 transition-colors shadow-md"><RotateCcw size={24} className="mx-auto" /></button>
            </div>
          </div>
        </div>

        {/* COLUMNA DERECHA: COACH Y PANEL */}
        <div className="w-full lg:w-[400px] flex flex-col gap-4">
          
          <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 space-y-4 shadow-lg">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-[#e2b96f] font-bold block mb-1">Entrenador Activo</label>
              <select 
                value={coachId} 
                onChange={handleCoachChange}
                className="w-full bg-slate-900 text-white p-2 rounded-lg border border-slate-600 outline-none focus:border-[#e2b96f]"
              >
                <option value="magnus">Magnus Carlsen</option>
                <option value="hikaru">Hikaru Nakamura</option>
                <option value="fischer">Bobby Fischer</option>
              </select>
            </div>

            <div className="flex items-center justify-between p-2 bg-slate-900/50 rounded-lg border border-slate-700">
              <span className="text-xs text-slate-300 flex items-center gap-2">
                {showArrows ? <Eye size={14} /> : <EyeOff size={14} />} Ayudas visuales
              </span>
              <button 
                onClick={() => setShowArrows(!showArrows)}
                className={`w-10 h-5 rounded-full transition-colors relative ${showArrows ? 'bg-[#e2b96f]' : 'bg-slate-600'}`}
              >
                <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${showArrows ? 'left-6' : 'left-1'}`} />
              </button>
            </div>
          </div>

          <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg">
            <h3 className="text-[10px] uppercase tracking-wider text-[#e2b96f] font-bold mb-3 flex items-center gap-2"><Brain size={14} /> Sugerencias Estratégicas</h3>
            <div className="space-y-2">
              {analysis?.suggestions.map((s, i) => (
                <div key={i} className="flex justify-between font-mono bg-slate-900/50 p-2 rounded border border-slate-700/50 text-sm">
                  <span className="text-white">{i + 1}. {s.san}</span>
                  <span className="text-slate-400">{s.score}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg">
            <h3 className="text-[10px] uppercase tracking-wider text-[#e2b96f] font-bold mb-2">Consejo del Pro</h3>
            <div className="text-sm leading-relaxed text-slate-300 italic min-h-[60px]">
              {loading ? "Analizando posición..." : (analysis?.explanation || "Mueve para recibir feedback.")}
            </div>
          </div>

          <div className="bg-slate-800 rounded-xl border border-slate-700 flex flex-col h-[280px] overflow-hidden shadow-lg">
             <div className="p-3 border-b border-slate-700 bg-slate-900/30 flex items-center gap-2">
                <MessageSquare size={14} className="text-[#e2b96f]" />
                <span className="text-[10px] uppercase font-bold text-[#e2b96f]">Chat Interactivo</span>
             </div>
             <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {chatLog.map((msg, i) => (
                  <div key={i} className={`${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                    <div className={`inline-block p-2 px-3 rounded-2xl text-sm ${msg.role === 'user' ? 'bg-[#e2b96f] text-slate-900 font-medium' : 'bg-slate-700 text-white'}`}>
                      {msg.text}
                    </div>
                  </div>
                ))}
             </div>
             <div className="p-3 bg-slate-900 flex gap-2">
                <input 
                  type="text" 
                  value={chatQuestion}
                  onChange={(e) => setChatQuestion(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && sendChat()}
                  placeholder="Pregunta algo..."
                  className="flex-1 bg-transparent text-sm outline-none text-white px-2"
                />
                <button onClick={sendChat} className="text-[#e2b96f] text-xs font-bold uppercase p-2 hover:text-white transition-colors">Enviar</button>
             </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;