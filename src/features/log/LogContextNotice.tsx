import React, { useEffect, useState } from 'react';
import { LogRowModel } from '@grafana/data';
import { Alert, Button } from '@grafana/ui';
import { CONTEXT_NOTE, contextProblem, contextSession, contextUsesPod } from './logContext';
import { useContextLayout } from './useContextLayout';

/** Native context-view extension: scope, fixed window, and actionable errors. */
export function LogContextNotice({ row }: { row: LogRowModel }) {
  const problem = contextProblem(row);
  const session = problem ? undefined : contextSession(row);
  const [error, setError] = useState(session?.error);
  const layout = useContextLayout();
  useEffect(() => {
    setError(session?.error);
    return session?.subscribe(() => setError(session.error));
  }, [session]);

  return (
    <div ref={layout.ref} style={{ width: '100%', minWidth: 0 }}>
      <Alert title="OpenObserve context V1" severity="info">
        {CONTEXT_NOTE}
        {!problem && !contextUsesPod(row) && (
          <p>No valid kubernetes_pod_name on this log: context includes all pods for this environment and service.</p>
        )}
        {layout.oversized && (
          <div>
            <p>Large matched line: sticky display is disabled so it can scroll. The native pin icon may remain on.</p>
            <Button size="sm" variant="secondary" onClick={() => layout.jump('before')}>
              Above matched line
            </Button>{' '}
            <Button size="sm" variant="secondary" onClick={() => layout.jump('after')}>
              Below matched line
            </Button>
          </div>
        )}
      </Alert>
      {(problem || error) && (
        <Alert title="Context unavailable" severity="error">
          {problem || error}
        </Alert>
      )}
    </div>
  );
}
