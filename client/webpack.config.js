const path = require('path');

module.exports = {
  mode: 'production',
  entry: path.resolve(__dirname, 'index.tsx'),
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, '../public/openrpc'),
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
};
