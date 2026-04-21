import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { Chess } from 'chess.js';

export interface Suggestion { uci: string; san: string; score: string; }

type Resolver = (suggestions: Suggestion[]) => void;

export class StockfishService {
  // En Linux (Render) stockfish se instala en /usr/games/stockfish
  // En Windows local usamos la ruta al .exe
  private enginePath = process.platform === 'win32'
    ? 'C:\\chess\\stockfish-windows-x86-64-avx2\\stockfish\\stockfish-windows-x86-64-avx2.exe'
    : '/usr/games/stockfish';

  private process: ChildProcessWithoutNullStreams | null = null;
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
    try {
      this.process = spawn(this.enginePath);
    } catch (e) {
      console.error('[Stockfish] No se pudo iniciar el motor:', e);
      return;
    }

    this.process.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) this.handleLine(line.trim());
    });

    this.process.stderr.on('data', (data: Buffer) =>
      console.error('[Stockfish stderr]', data.toString())
    );

    this.process.on('close', (code) => {
      console.warn(`[Stockfish] cerrado (${code}). Reiniciando en 1s...`);
      this.ready = false;
      setTimeout(() => this.start(), 1000);
    });

    this.write('uci');
    this.write('setoption name MultiPV value 3');
    this.write('isready');
  }

  private write(cmd: string) {
    this.process?.stdin.write(cmd + '\n');
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
    this.write('quit');
    this.process?.kill();
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