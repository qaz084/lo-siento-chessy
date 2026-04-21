import { Chess } from 'chess.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export interface Suggestion { uci: string; san: string; score: string; }

type Resolver = (suggestions: Suggestion[]) => void;

export class StockfishService {
  private engine: any = null;
  private ready = false;

  private currentFen = '';
  private currentDepth = 12;
  private currentLines: string[] = [];
  private currentResolve: Resolver | null = null;

  private nextFen: string | null = null;
  private nextDepth = 12;
  private nextResolve: Resolver | null = null;

  private ignoreNextBestmove = false;

  constructor() {
    this.start();
  }

  private start() {
    const stockfishFactory = require('stockfish');
    // v18: la factory devuelve un objeto con .then() o directamente el engine
    const instance = stockfishFactory();

    const init = (eng: any) => {
      this.engine = eng;

      // v18 usa 'listener' para recibir output
      this.engine.listener = (line: string) => {
        if (typeof line === 'string') this.handleLine(line.trim());
      };

      // fallback por si usa onmessage (versiones anteriores)
      this.engine.onmessage = (msg: any) => {
        const text = typeof msg === 'object' ? msg.data : msg;
        if (typeof text === 'string') this.handleLine(text.trim());
      };

      this.write('uci');
      this.write('setoption name MultiPV value 3');
      this.write('isready');
    };

    // Algunos builds son async (Promise), otros síncronos
    if (instance && typeof instance.then === 'function') {
      instance.then(init);
    } else {
      init(instance);
    }
  }

  private write(cmd: string) {
    if (!this.engine) return;
    // v18 usa postMessage, versiones anteriores también — pero el engine
    // puede exponerlo como propiedad del objeto o del módulo
    if (typeof this.engine.postMessage === 'function') {
      this.engine.postMessage(cmd);
    } else if (typeof this.engine === 'function') {
      this.engine(cmd);
    } else {
      console.error('[Stockfish] No se encontró método para enviar comandos');
    }
  }

  private handleLine(line: string) {
    if (!line) return;

    if (line === 'readyok') {
      this.ready = true;
      if (this.nextResolve) {
        this.dispatch(this.nextFen!, this.nextDepth, this.nextResolve);
        this.nextFen = null;
        this.nextResolve = null;
      }
      return;
    }

    if (line.includes('multipv') && line.includes(`depth ${this.currentDepth}`)) {
      this.currentLines.push(line);
      return;
    }

    if (line.startsWith('bestmove')) {
      if (this.ignoreNextBestmove) {
        this.ignoreNextBestmove = false;
        if (this.nextResolve) {
          this.dispatch(this.nextFen!, this.nextDepth, this.nextResolve);
          this.nextFen = null;
          this.nextResolve = null;
        }
        return;
      }

      const resolve = this.currentResolve;
      const fen = this.currentFen;
      const lines = [...this.currentLines];

      this.currentResolve = null;
      this.currentLines = [];
      resolve?.(this.parseMultiPV(lines, fen));

      if (this.nextResolve) {
        this.dispatch(this.nextFen!, this.nextDepth, this.nextResolve);
        this.nextFen = null;
        this.nextResolve = null;
      }
    }
  }

  private dispatch(fen: string, depth: number, resolve: Resolver) {
    this.currentFen = fen;
    this.currentDepth = depth;
    this.currentLines = [];
    this.currentResolve = resolve;
    this.write(`position fen ${fen}`);
    this.write(`go depth ${depth}`);
  }

  async analyze(fen: string, depth = 12): Promise<Suggestion[]> {
    return new Promise((resolve) => {
      if (!this.ready) {
        this.nextFen = fen;
        this.nextDepth = depth;
        this.nextResolve = resolve;
        return;
      }

      if (this.currentResolve) {
        this.nextFen = fen;
        this.nextDepth = depth;
        this.nextResolve = resolve;
        this.ignoreNextBestmove = true;
        this.write('stop');
        return;
      }

      this.dispatch(fen, depth, resolve);
    });
  }

  shutdown() {
    try { this.engine?.terminate?.(); } catch (_) {}
  }

  private parseMultiPV(lines: string[], fen: string): Suggestion[] {
    const suggestions: Suggestion[] = [];
    const lastThree = lines.slice(-3);

    lastThree.forEach((pvLine) => {
      const parts = pvLine.split(' pv ');
      if (parts.length < 2) return;

      const uciMove = parts[1].split(' ')[0];
      const cpMatch = pvLine.match(/score cp (-?\d+)/);
      const mateMatch = pvLine.match(/score mate (-?\d+)/);

      let score = "0.0";
      if (mateMatch) score = `#${mateMatch[1]}`;
      else if (cpMatch) score = (parseInt(cpMatch[1]) / 100).toFixed(1);

      const tempGame = new Chess(fen);
      try {
        const moveObj = tempGame.move({
          from: uciMove.substring(0, 2),
          to: uciMove.substring(2, 4),
          promotion: 'q'
        });
        suggestions.push({ uci: uciMove, san: moveObj.san, score });
      } catch (e) {
        suggestions.push({ uci: uciMove, san: uciMove, score });
      }
    });

    return suggestions.sort((a, b) => parseFloat(b.score) - parseFloat(a.score));
  }
}