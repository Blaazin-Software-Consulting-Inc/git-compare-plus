import { describe, expect, it } from 'vitest';
import { createChannelLogger, describeError, type LogSink } from '../src/logger';

function recordingSink(): LogSink & { lines: [string, string][] } {
  const lines: [string, string][] = [];
  return {
    lines,
    debug: (l) => lines.push(['debug', l]),
    info: (l) => lines.push(['info', l]),
    warn: (l) => lines.push(['warn', l]),
    error: (l) => lines.push(['error', l]),
  };
}

describe('createChannelLogger', () => {
  it('writes a constant message followed by one JSON object with the component', () => {
    const sink = recordingSink();
    createChannelLogger(sink, 'Comp').info('thing happened', { function: 'f', count: 2 });
    expect(sink.lines).toEqual([['info', 'thing happened {"component":"Comp","function":"f","count":2}']]);
  });

  it('routes each level to the matching sink method', () => {
    const sink = recordingSink();
    const logger = createChannelLogger(sink, 'C');
    logger.debug('d');
    logger.warn('w');
    logger.error('e', new Error('x'));
    expect(sink.lines.map(([level]) => level)).toEqual(['debug', 'warn', 'error']);
  });

  it('expands errors into name/message/stack fields', () => {
    const sink = recordingSink();
    createChannelLogger(sink, 'C').error('failed', new TypeError('bad'), { repo: 'r' });
    const json = JSON.parse(sink.lines[0][1].slice('failed '.length));
    expect(json).toMatchObject({ component: 'C', repo: 'r', error: { name: 'TypeError', message: 'bad' } });
    expect(json.error.stack).toContain('TypeError: bad');
  });

  it('never throws on unserializable fields', () => {
    const sink = recordingSink();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => createChannelLogger(sink, 'C').info('m', { circular })).not.toThrow();
    expect(sink.lines[0][1]).toBe('m {"logFormatError":true}');
  });
});

describe('describeError', () => {
  it('wraps non-Error throwables', () => {
    expect(describeError('boom')).toEqual({ name: 'NonError', message: 'boom' });
  });
});
