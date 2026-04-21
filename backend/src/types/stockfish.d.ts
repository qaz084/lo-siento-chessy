declare module 'stockfish' {
    function stockfish(): {
        onmessage: (event: any) => void;
        postMessage: (command: string) => void;
        terminate: () => void;
    };
    export default stockfish;
}