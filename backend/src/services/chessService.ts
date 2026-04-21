import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const stockfish = require('stockfish'); // Cargamos la librería de forma segura

import { Chess } from 'chess.js';

export interface Suggestion {
  uci: string;
  san: string;
  score: string;
}

export const analyzePosition = (fen: string, depth = 12): Promise<Suggestion[]> => {
  return new Promise((resolve) => {
    // La librería stockfish exporta una función que inicializa el motor
    const engine = stockfish();
    let lines: string[] = [];

    engine.onmessage = (line: any) => {
      if (typeof line !== 'string') return;

      if (line.includes(`depth ${depth}`) && line.includes('multipv')) {
        lines.push(line);
      }
      if (line.startsWith('bestmove')) {
        engine.postMessage('quit'); // Terminamos el motor correctamente
        resolve(parseMultiPV(lines, fen));
      }
    };

    engine.postMessage('uci');
    engine.postMessage('setoption name MultiPV value 3');
    engine.postMessage(`position fen ${fen}`);
    engine.postMessage(`go depth ${depth}`);
  });
};

const parseMultiPV = (lines: string[], fen: string): Suggestion[] => {
  const suggestions: Suggestion[] = [];
  // Tomamos las últimas 3 líneas de profundidad máxima
  const lastLines = lines.slice(-3);

  lastLines.forEach((pvLine) => {
    try {
      const parts = pvLine.split(' pv ');
      if (parts.length < 2) return;

      const uciMove = parts[1].split(' ')[0];
      const cpMatch = pvLine.match(/score cp (-?\d+)/);
      const score = cpMatch ? (parseInt(cpMatch[1]) / 100).toFixed(1) : "0.0";
      
      const tempGame = new Chess(fen);
      const moveObj = tempGame.move({ 
        from: uciMove.substring(0, 2), 
        to: uciMove.substring(2, 4), 
        promotion: 'q' 
      });

      suggestions.push({ 
        uci: uciMove, 
        san: moveObj ? moveObj.san : uciMove, 
        score 
      });
    } catch (e) {
      console.error("Error parseando línea:", pvLine);
    }
  });

  // Ordenar por puntaje (mejor jugada primero)
  return suggestions.sort((a, b) => parseFloat(b.score) - parseFloat(a.score));
};