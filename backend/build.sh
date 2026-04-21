#!/bin/bash
set -e

echo "==> Descargando Stockfish..."
mkdir -p bin
curl -L https://github.com/official-stockfish/Stockfish/releases/download/sf_17/stockfish-ubuntu-x86-64-avx2.tar -o stockfish.tar
tar -xf stockfish.tar
mv stockfish/stockfish-ubuntu-x86-64-avx2 bin/stockfish
chmod +x bin/stockfish
rm -rf stockfish stockfish.tar

echo "==> Stockfish instalado en bin/stockfish"
echo "==> Instalando dependencias..."
npm install

echo "==> Compilando TypeScript..."
npm run build