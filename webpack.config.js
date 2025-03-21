import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  entry: './src/AggregatorGateway.ts',
  mode: 'production',
  output: {
    filename: 'aggregator.cjs',
    path: path.resolve(__dirname, 'dist')
  },
  resolve: {
    extensions: ['.ts', '.js'],
    extensionAlias: {
      '.js': ['.js', '.ts']
    }
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: {
            allowTsInNodeModules: true
          }
        },
        exclude: /node_modules\/(?!@unicitylabs)/
      }
    ]
  },
  target: 'node'
};
