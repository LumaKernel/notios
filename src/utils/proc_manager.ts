import { AnsiParser } from 'ansi-parser/interfaces/ansi-parser';
import { decodeAnsiBytes, defaultAnsiParser } from 'ansi-parser/src';
import type childProcess from 'child_process';
import cp from 'cross-spawn';
import tty from 'tty';
import { envVarNames } from '../constants/ipc';
import { applyActionToSty, defaultStyContext, restoreSty, StyContext } from './sty';

export type ProcStatus = 'waiting' | 'running' | 'finished';

export interface ProcOwn {
  readonly command: string;
  readonly cwd: string;
  readonly npmPath: string;
}

export interface ProcOwnInternal {
  command: string;
  cwd: string;
  npmPath: string;
  $raw?: childProcess.ChildProcessWithoutNullStreams;
}

export interface LogOwn {
  readonly currentSty: StyContext;
  readonly currentParser: AnsiParser;
}
export interface LogOwnInternal {
  currentSty: StyContext;
  currentParser: AnsiParser;
}

export interface LogLine {
  timestamp?: Date;
  title: string;
  id: number;
  content: LogContent;
}
export interface LogLineReadonly {
  readonly timestamp?: Date;
  readonly title: string;
  readonly content: LogContentReadonly;
}
export type LogLines = LogLine[];
export type LogLinesReadonly = readonly LogLineReadonly[];
export type LogContent = Array<
  | {
      readonly type: 'style';
      readonly bytes: Uint8Array;
    }
  | {
      readonly type: 'print';
      readonly byte: number;
    }
>;
export type LogContentReadonly = Readonly<LogContent>;

export interface LogAccumulated {
  readonly lineCount: number;
  // TODO(perf): better to use deque
  readonly lines: LogLinesReadonly;
}
export interface LogAccumulatedInternal {
  lineCount: number;
  lines: LogLines;
  $lastLineToTitle: Record<string, LogLine>;
}

export type ProcNodeType = 'none' | 'serial' | 'parallel';

export interface ProcNode {
  readonly name: string;
  readonly type: ProcNodeType;
  readonly parent?: ProcNode;
  readonly procOwn?: ProcOwn;
  readonly logOwn?: LogOwn;
  readonly exitCode?: number | null;
  readonly children: readonly ProcNode[];
  readonly token: string;
  readonly status: ProcStatus;
  readonly logAccumulated: LogAccumulated;
  readonly addUpdateListener: AddUpdateListener;
  readonly removeUpdateListener: RemoveUpdateListener;
}

export interface ProcNodeInternal {
  name: string;
  type: ProcNodeType;
  parent?: ProcNodeInternal;
  procOwn?: ProcOwnInternal;
  logOwn?: LogOwnInternal;
  children: ProcNodeInternal[];
  token: string;
  status: ProcStatus;
  exitCode?: number | null;
  logAccumulated: LogAccumulatedInternal;
  npmPath?: string;
  addUpdateListener: AddUpdateListener;
  removeUpdateListener: RemoveUpdateListener;
  $notifyUpdate: () => void;
}
export type ProcNodeInternalInitial = Omit<
  ProcNodeInternal,
  'token' | 'addUpdateListener' | 'removeUpdateListener' | '$notifyUpdate'
>;
export type FindNodeByToken = (token?: string | undefined) => ProcNode | undefined;
export type FindNodeByTokenInternal = (token?: string | undefined) => ProcNodeInternal | undefined;

export type CreateNodeParams = Omit<
  ProcNode,
  'parent' | 'children' | 'token' | 'addUpdateListener' | 'removeUpdateListener' | 'log'
> & { parentToken?: string | undefined };

export type CreateNode = (createNodeParams: CreateNodeParams) => ProcNode | null;
export type RestartNode = (node?: ProcNode | null | undefined) => void;
export type UpdateListener = () => void;
export type AddUpdateListener = (updateListener: UpdateListener) => void;
export type RemoveUpdateListener = (updateListener: UpdateListener) => void;

export interface ProcManager {
  readonly createNode: CreateNode;
  readonly restartNode: RestartNode;
  readonly rootNode: ProcNode;
  readonly addUpdateListener: AddUpdateListener;
  readonly removeUpdateListener: RemoveUpdateListener;
  readonly findNodeByToken: FindNodeByToken;
}

export interface CreateProcManagerParams {
  forceNoColor: boolean;
}
export const createProcManager = ({ forceNoColor }: CreateProcManagerParams): ProcManager => {
  const $updateListenerSet = new Set<UpdateListener>();
  // Call when tree structure changed.
  const $notifyUpdate = (): void => {
    [...$updateListenerSet].forEach((listener) => {
      listener();
    });
  };

  const $tokenToNodeMap = new Map<string, ProcNodeInternal>();
  const $checkSerial = (node: ProcNodeInternalInitial) => {
    if (node.status === 'running' && node.type === 'serial' && node.children.length > 0) {
      if (node.children[0].status === 'waiting') {
        $startRunning(node.children[0]);
      } else {
        for (let i = 0; i + 1 < node.children.length; i += 1) {
          if (node.children[i].status === 'finished' && node.children[i + 1].status === 'waiting') {
            $startRunning(node.children[i + 1]);
          }
        }
      }
    }
  };

  const $createNode = (nodeInitial: ProcNodeInternalInitial): ProcNodeInternal => {
    const $updateListenerSet = new Set<UpdateListener>();
    const addUpdateListener: AddUpdateListener = (listener) => {
      $updateListenerSet.add(listener);
    };
    const removeUpdateListener: RemoveUpdateListener = (listener) => {
      $updateListenerSet.delete(listener);
    };
    const token = (() => {
      while (true) {
        const tmpToken = Math.random().toString().slice(2, 14);
        if ($tokenToNodeMap.has(tmpToken)) continue;
        return tmpToken;
      }
    })();
    const node: ProcNodeInternal = {
      ...nodeInitial,
      addUpdateListener,
      removeUpdateListener,
      token,
      $notifyUpdate: (): void => {
        [...$updateListenerSet].forEach((listener) => {
          listener();
        });
        if (node.children.length > 0) {
          node.status = (() => {
            const statuses = node.children.map((child) => child.status);
            const allFinished = Math.max(...statuses.map((s) => (s === 'finished' ? 0 : 1))) === 0;
            const allWaiting = Math.max(...statuses.map((s) => (s === 'waiting' ? 0 : 1))) === 0;
            if (allFinished) return 'finished';
            if (allWaiting) return 'waiting';
            return 'running';
          })();
          node.exitCode = node.children.reduce((accum, n) => accum || n.exitCode, null as null | number | undefined);
        }
        $checkSerial(node);
        const knownTitle: Record<string, boolean> = {};
        node.logAccumulated.lineCount = 0;
        const beingAdded: LogLines = [];
        for (const child of node.children) {
          node.logAccumulated.lineCount += child.logAccumulated.lineCount;

          let title = node.name;
          let titleCnt = 0;
          while (knownTitle[title]) {
            titleCnt += 1;
            title = `${node.name}(${titleCnt})`;
          }
          knownTitle[title] = true;
          const childLines = child.logAccumulated.lines;
          const lastLine = node.logAccumulated.$lastLineToTitle[title];
          let from = 0;
          if (lastLine) {
            from = childLines.length - 1;
            while (from >= 1 && childLines[from].id !== lastLine.id) from -= 1;
            // The last line may be wiped out from history.
            if (childLines[from].id === lastLine.id) from += 1;
          }
          if (childLines.length > 0) {
            node.logAccumulated.$lastLineToTitle[title] = childLines[childLines.length - 1];
          }
          beingAdded.push(...childLines.slice(from));
        }
        const lines = node.logAccumulated.lines;
        lines.push(
          ...beingAdded.filter((e) => e.timestamp).sort((a, b) => a.timestamp!.getTime() - b.timestamp!.getTime()),
        );

        // Wiping out the history.
        node.logAccumulated.lines = lines.slice(-3000);

        node.parent?.$notifyUpdate();
      },
    };
    $tokenToNodeMap.set(token, node);
    return node;
  };

  const $appendLogToNode = (newLog: Buffer, node: ProcNodeInternal) => {
    if (!node.logOwn) throw new Error('[INTERNAL UNREACHABLE ERROR]: appending to log-accumulate-only node');
    const [newParser, actions] = decodeAnsiBytes(node.logOwn.currentParser, new Uint8Array(newLog));
    node.logOwn.currentParser = newParser;
    for (const action of actions) {
      const lines = node.logAccumulated.lines;
      if (lines.length === 0) {
        const title = '';
        const logLine: LogLine = {
          timestamp: undefined,
          title,
          id: lines.length,
          content: [],
        };
        lines.push(logLine);
        node.logAccumulated.$lastLineToTitle[title] = logLine;
      }
      const lastLine = lines[lines.length - 1];
      const checkTimestamp = (line: LogLine) => {
        if (!line.timestamp) {
          line.timestamp = new Date();
          node.logAccumulated.lineCount += 1;
        }
      };
      switch (action.actionType) {
        case 'print':
          checkTimestamp(lastLine);
          lastLine.content.push({
            type: 'print',
            byte: action.byte,
          });
          break;
        case 'controll':
          switch (action.char) {
            case '\t':
              checkTimestamp(lastLine);
              lastLine.content.push({
                type: 'print',
                byte: 0x20,
              });
              break;
            case '\n': {
              checkTimestamp(lastLine);
              const title = '';
              const logLine: LogLine = {
                timestamp: undefined,
                title,
                id: lines.length,
                content: [
                  {
                    type: 'style',
                    bytes: restoreSty(node.logOwn.currentSty),
                  },
                ],
              };
              lines.push(logLine);
              node.logAccumulated.$lastLineToTitle[title] = logLine;
              break;
            }
            default:
              // ignore
              break;
          }
          break;
        default:
          node.logOwn.currentSty = applyActionToSty(node.logOwn.currentSty, action);
          lastLine.content.push({
            type: 'style',
            bytes: restoreSty(node.logOwn.currentSty),
          });
          break;
      }
    }
  };

  const $createEmptyLogOwn = (): LogOwnInternal => {
    return {
      currentSty: defaultStyContext(),
      currentParser: defaultAnsiParser(),
    };
  };

  const $createEmptyLogAccumulated = (): LogAccumulatedInternal => {
    return {
      lineCount: 0,
      lines: [],
    };
  };

  const rootNode = $createNode({
    name: '<root>',
    status: 'waiting',
    type: 'none',
    logOwn: $createEmptyLogOwn(),
    logAccumulated: $createEmptyLogAccumulated(),
    children: [],
  });

  const findNodeByToken: FindNodeByTokenInternal = (token) => {
    if (typeof token === 'string') {
      return $tokenToNodeMap.get(token);
    }
    return rootNode;
  };

  const $startRunning = (node: ProcNodeInternal) => {
    node.status = 'running';
    if (!node.procOwn) {
      $checkSerial(node);
      return;
    }
    const nodeStdout = $createNode({
      name: '<out>',
      status: 'running',
      type: 'none',
      logOwn: $createEmptyLogOwn(),
      logAccumulated: $createEmptyLogAccumulated(),
      children: [],
    });
    const nodeStderr = $createNode({
      name: '<err>',
      status: 'running',
      type: 'none',
      logOwn: $createEmptyLogOwn(),
      logAccumulated: $createEmptyLogAccumulated(),
      children: [],
    });
    node.children = [nodeStdout, nodeStderr, ...node.children];
    nodeStdout.parent = node;
    nodeStderr.parent = node;
    $notifyUpdate();

    const isColorSupported =
      !('NO_COLOR' in process.env || forceNoColor) &&
      ('FORCE_COLOR' in process.env ||
        process.platform === 'win32' ||
        (tty.isatty(1) && process.env.TERM !== 'dumb') ||
        'CI' in process.env);

    const p = cp.spawn(node.procOwn.npmPath, ['run', node.name], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: node.procOwn.cwd,
      env: {
        ...process.env,
        ...(isColorSupported
          ? {
              npm_config_color: 'always',
              NO_COLOR: undefined,
              FORCE_COLOR: 'true',
              CARGO_TERM_COLOR: 'always',
            }
          : {
              npm_config_color: 'false',
              NO_COLOR: 'true',
              FORCE_COLOR: '0',
              CARGO_TERM_COLOR: 'none',
            }),
        [envVarNames.rootToken]: rootNode.token,
        [envVarNames.parentToken]: node.token,
      },
    });
    node.procOwn.$raw = p;

    node.$notifyUpdate();

    p.stdout.on('data', (buf: Buffer) => {
      $appendLogToNode(buf, nodeStdout);
      nodeStdout.$notifyUpdate();
    });
    p.stderr.on('data', (buf: Buffer) => {
      $appendLogToNode(buf, nodeStderr);
      nodeStderr.$notifyUpdate();
    });
    p.on('exit', (exitCode) => {
      nodeStdout.status = 'finished';
      nodeStderr.status = 'finished';
      nodeStdout.exitCode = exitCode;
      nodeStderr.exitCode = exitCode;
      nodeStdout.$notifyUpdate();
      nodeStderr.$notifyUpdate();
    });
  };

  const createNode: CreateNode = ({ parentToken, ...params }) => {
    // Just ignore if spawn request is from older world.
    const parentNode: ProcNodeInternal | undefined = findNodeByToken(parentToken);
    if (parentNode == null) return null;

    const node = $createNode({
      ...params,
      logOwn: $createEmptyLogOwn(),
      logAccumulated: $createEmptyLogAccumulated(),
      children: [],
    });

    parentNode.children.push(node);
    node.parent = parentNode;

    if (params.procOwn && params.status === 'running') {
      $startRunning(node);
    }
    return node;
  };
  const addUpdateListener: AddUpdateListener = (listener) => {
    $updateListenerSet.add(listener);
  };
  const removeUpdateListener: RemoveUpdateListener = (listener) => {
    $updateListenerSet.delete(listener);
  };

  const restartNode: RestartNode = (node) => {
    if (!node) return;
    const inode: ProcNodeInternal = node as any;
    if (!inode.procOwn) return;
    if (inode.status !== 'finished') return;
    inode.children = [];
    // TODO: show something description about restarting
    $startRunning(inode);
  };

  return {
    createNode,
    restartNode,
    rootNode,
    addUpdateListener,
    removeUpdateListener,
    findNodeByToken,
  };
};
