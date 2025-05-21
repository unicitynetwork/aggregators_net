import React, { useEffect, useRef } from 'react';
import Playground from '@open-rpc/playground';

export default function OpenRpcApp(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      Playground.init({ schemaUrl: '/openrpc.json' }, containerRef.current);
    }
  }, []);

  return <div ref={containerRef} style={{ height: '100vh' }} />;
}
