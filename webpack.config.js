import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default [
  // Main application build
  {
    entry: './src/index.ts',
    mode: 'production',
    output: {
      filename: 'index.cjs',
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
        },
        {
          test: /\.node$/,
          loader: "node-loader"
        }
      ]
    },
    /* Uncomment to improve stack trace for debugging.
    optimization: {
      minimize: false
    },
    */
    target: 'node',
    externals: {
      'kerberos': 'commonjs kerberos',
      '@mongodb-js/zstd': 'commonjs @mongodb-js/zstd',
      '@aws-sdk/credential-providers': 'commonjs @aws-sdk/credential-providers',
      'gcp-metadata': 'commonjs gcp-metadata',
      'snappy': 'commonjs snappy',
      'socks': 'commonjs socks',
      'aws4': 'commonjs aws4',
      'mongodb-client-encryption': 'commonjs mongodb-client-encryption',
      'mongodb-memory-server': 'commonjs mongodb-memory-server'
    },
    ignoreWarnings: [
      {
        module: /express\/lib\/view\.js$/,
        message: /Critical dependency: the request of a dependency is an expression/
      }
    ]
  },
  
  // Validation worker build
  {
    entry: './src/workers/validation-worker.ts',
    mode: 'production',
    output: {
      filename: 'workers/validation-worker.cjs',
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
    target: 'node',
    externals: {
      'threads/worker': 'commonjs threads/worker',
      'kerberos': 'commonjs kerberos',
      '@mongodb-js/zstd': 'commonjs @mongodb-js/zstd',
      '@aws-sdk/credential-providers': 'commonjs @aws-sdk/credential-providers',
      'gcp-metadata': 'commonjs gcp-metadata',
      'snappy': 'commonjs snappy',
      'socks': 'commonjs socks',
      'aws4': 'commonjs aws4',
      'mongodb-client-encryption': 'commonjs mongodb-client-encryption',
      'mongodb-memory-server': 'commonjs mongodb-memory-server'
    }
  }
];
