// src/lib/founder-console-view.test.ts — run: npx vitest run src/lib/founder-console-view.test.ts
//
// Everything asserted here is SYNCHRONOUS and pure. The two database functions in the module under
// test (assignableRoster, mayAssignTo) are deliberately not exercised: they are authority mirrors of
// createTask()'s own clause and the only honest test of them is against a real row, which this suite
// will not open a connection to do.
//
// The bugs these assertions exist to catch are all the same bug wearing different clothes: a value
// that means "we could not tell" rendered as a value that means "there is nothing".
import { describe, it, expect } from 'vitest';
import {
  layoutChart,
  CHART_NODE_W,
  CHART_NODE_H,
  CHART_COL_GAP,
  CHART_ROW_GAP,
  waitingDays,
  waitingLabel,
  waitingBand,
  sortByWaiting,
  queueHeadline,
  loadSentence,
  parseLoadSort,
  sortRoster,
  graphStateSentence,
  twoSourcesSentence,
  noAssigneesSentence,
  type ChartNodeInput,
  type LoadRow,
} from './founder-console-view';

const person = (
  name: string,
  depth: number,
  children: ChartNodeInput[] = [],
  extra: Partial<ChartNodeInput> = {},
): ChartNodeInput => ({
  employeeId: name.toLowerCase(),
  fullName: name,
  designation: '',
  depth,
  isViewer: false,
  tags: [],
  children,
  ...extra,
});

describe('layoutChart — the geometry of the drawn organization', () => {
  it('places depth across and siblings down', () => {
    const tree = person('Root', 0, [person('A', 1), person('B', 1)]);
    const out = layoutChart([{ roots: [tree] }]);
    expect(out.drawn).toBe(3);
    expect(out.nodes[0].x).toBe(0);
    expect(out.nodes[0].y).toBe(0);
    // A is depth 1, row 1. B is depth 1, row 2.
    expect(out.nodes[1].x).toBe(CHART_NODE_W + CHART_COL_GAP);
    expect(out.nodes[1].y).toBe(CHART_NODE_H + CHART_ROW_GAP);
    expect(out.nodes[2].x).toBe(CHART_NODE_W + CHART_COL_GAP);
    expect(out.nodes[2].y).toBe(2 * (CHART_NODE_H + CHART_ROW_GAP));
  });

  it('draws one connector per non-root node, and none for a root', () => {
    const out = layoutChart([{ roots: [person('Root', 0, [person('A', 1, [person('A1', 2)])])] }]);
    expect(out.links).toHaveLength(2);
    // Straight segments only: no curve command, and no arrow character anywhere near a JSX string.
    expect(out.links[0].d).toMatch(/^M [\d.]+ [\d.]+ H [\d.]+ V [\d.]+ H [\d.]+$/);
  });

  it('reports what the ceiling cut, counting the whole dropped subtree and not just its root', () => {
    // Six people, limit of two. The four not drawn must be COUNTED, including the grandchildren of a
    // root the walk abandoned — a chart that quietly stopped would look like a smaller company.
    const deep = person('R', 0, [
      person('A', 1, [person('A1', 2), person('A2', 2)]),
      person('B', 1, [person('B1', 2)]),
    ]);
    const out = layoutChart([{ roots: [deep] }], 2);
    expect(out.drawn).toBe(2);
    expect(out.omitted).toBe(4);
  });

  it('never renders a bare uuid where a name is missing', () => {
    const out = layoutChart([{ roots: [person('x', 0, [], { fullName: null, employeeId: 'e-1' })] }]);
    expect(out.nodes[0].name).toBe('Name not recorded');
    expect(out.nodes[0].employeeId).toBe('e-1');
  });

  it('an empty graph lays out to nothing rather than to a placeholder person', () => {
    const out = layoutChart([]);
    expect(out.drawn).toBe(0);
    expect(out.nodes).toHaveLength(0);
    expect(out.links).toHaveLength(0);
    expect(out.omitted).toBe(0);
  });

  it('width follows depth, not breadth — the reason the chart is drawn sideways', () => {
    const wide = layoutChart([{ roots: [person('R', 0, [person('A', 1), person('B', 1), person('C', 1)])] }]);
    const deep = layoutChart([{ roots: [person('R', 0, [person('A', 1, [person('A1', 2)])])] }]);
    expect(wide.width).toBe(CHART_NODE_W + CHART_COL_GAP + CHART_NODE_W);
    expect(deep.width).toBeGreaterThan(wide.width);
  });
});

describe('waiting — age is the ordering fact, and unknown is not zero', () => {
  const now = Date.parse('2026-08-10T12:00:00Z');

  it('counts whole days from an ISO timestamp', () => {
    expect(waitingDays('2026-08-07T12:00:00Z', now)).toBe(3);
    expect(waitingDays('2026-08-10T09:00:00Z', now)).toBe(0);
  });

  it('an absent or unreadable date is null, never 0', () => {
    expect(waitingDays('', now)).toBeNull();
    expect(waitingDays(null, now)).toBeNull();
    expect(waitingDays('not a date', now)).toBeNull();
  });

  it('bands escalate by age, and unknown gets its own band', () => {
    expect(waitingBand(0)).toBe('fresh');
    expect(waitingBand(3)).toBe('fresh');
    expect(waitingBand(4)).toBe('ageing');
    expect(waitingBand(13)).toBe('ageing');
    expect(waitingBand(14)).toBe('stale');
    expect(waitingBand(null)).toBe('unknown');
  });

  it('labels read as sentences a person can scan', () => {
    expect(waitingLabel(0)).toBe('waiting since today');
    expect(waitingLabel(1)).toBe('waiting 1 day');
    expect(waitingLabel(21)).toBe('waiting 21 days');
    expect(waitingLabel(null)).toMatch(/could not read/);
  });

  it('sorts oldest first, and puts unknown ages above everything', () => {
    const out = sortByWaiting([
      { id: 'a', waited: 1 },
      { id: 'b', waited: 21 },
      { id: 'c', waited: null },
      { id: 'd', waited: 5 },
    ]);
    expect(out.map((x) => x.id)).toEqual(['c', 'b', 'd', 'a']);
  });

  it('one three-week approval outranks nine from this morning', () => {
    const today = Array.from({ length: 9 }, (_, i) => ({ id: 'today' + i, waited: 0 }));
    const out = sortByWaiting([...today, { id: 'old', waited: 21 }]);
    expect(out[0].id).toBe('old');
  });

  it('an unreadable queue never reads as a clear desk', () => {
    expect(queueHeadline(0, null, false)).toMatch(/could not be read/);
    expect(queueHeadline(0, null, false)).not.toMatch(/Nothing is routed/);
    expect(queueHeadline(0, null, true)).toMatch(/Nothing is routed to you right now/);
    expect(queueHeadline(3, 19, true)).toMatch(/oldest has been there 19 days/);
  });
});

describe('load — nothing assigned is said as plainly as a full plate', () => {
  it('distinguishes idle, loaded, and unreadable', () => {
    expect(loadSentence({ active: 0, overdue: 0 })).toBe('Nothing assigned.');
    expect(loadSentence({ active: null, overdue: null })).toMatch(/could not be read/);
    expect(loadSentence({ active: 1, overdue: 0 })).toBe('1 task open, none of it overdue.');
    expect(loadSentence({ active: 7, overdue: 2 })).toBe('7 tasks open, 2 of it overdue.');
  });

  it('an unreadable count is never spelled as zero', () => {
    expect(loadSentence({ active: null, overdue: null })).not.toMatch(/Nothing assigned/);
    expect(loadSentence({ active: 4, overdue: null })).toMatch(/whether any of it is late could not be read/);
  });

  it('parseLoadSort accepts only the four columns and falls back to load', () => {
    expect(parseLoadSort('overdue')).toBe('overdue');
    expect(parseLoadSort('NAME')).toBe('name');
    expect(parseLoadSort('allocation')).toBe('allocation');
    expect(parseLoadSort('drop table')).toBe('load');
    expect(parseLoadSort(undefined)).toBe('load');
  });
});

describe('sortRoster — an unknown count must not lead a chart of who is busiest', () => {
  const row = (name: string, active: number | null, overdue: number | null, alloc: number | null): LoadRow => ({
    employeeId: name, name, designation: '', active, overdue, allocationPct: alloc, overAllocated: (alloc || 0) > 100,
  });
  const list: LoadRow[] = [
    row('Asha', 2, 0, 60),
    row('Bharat', null, null, null),
    row('Chandra', 9, 4, 140),
    row('Divya', 0, 0, 0),
  ];

  it('sorts by open work, busiest first, with unknown last', () => {
    expect(sortRoster(list, 'load').map((r) => r.name)).toEqual(['Chandra', 'Asha', 'Divya', 'Bharat']);
  });

  it('sorts by overdue, and an idle person still outranks an unreadable one', () => {
    expect(sortRoster(list, 'overdue').map((r) => r.name)).toEqual(['Chandra', 'Asha', 'Divya', 'Bharat']);
  });

  it('sorts by allocation, over-committed first', () => {
    expect(sortRoster(list, 'allocation')[0].name).toBe('Chandra');
    expect(sortRoster(list, 'allocation')[3].name).toBe('Bharat');
  });

  it('sorts by name without dropping anybody', () => {
    expect(sortRoster(list, 'name').map((r) => r.name)).toEqual(['Asha', 'Bharat', 'Chandra', 'Divya']);
  });

  it('does not mutate the list it was given', () => {
    const before = list.map((r) => r.name);
    sortRoster(list, 'overdue');
    expect(list.map((r) => r.name)).toEqual(before);
  });
});

describe('graphStateSentence — the most useful sentence on the screen today', () => {
  it('an empty graph with records behind it names the number and the fix', () => {
    const s = graphStateSentence({ initialized: false, withEdge: 0, columnOnly: 42, coverageOk: true });
    expect(s).toMatch(/has not been described yet/);
    expect(s).toMatch(/42 active employee records already have/);
    expect(s).toMatch(/backfill/);
  });

  it('never claims nobody reports to anybody', () => {
    const s = graphStateSentence({ initialized: false, withEdge: 0, columnOnly: 42, coverageOk: true });
    expect(s).not.toMatch(/nobody reports/i);
    expect(s).not.toMatch(/no reporting lines/i);
  });

  it('an empty graph with nothing behind it says so, without inventing a backfill to run', () => {
    const s = graphStateSentence({ initialized: false, withEdge: 0, columnOnly: 0, coverageOk: true });
    expect(s).toMatch(/nothing for the backfill to read yet/);
  });

  it('a failed coverage read is never rendered as full coverage or as zero', () => {
    const s = graphStateSentence({ initialized: false, withEdge: null, columnOnly: null, coverageOk: false });
    expect(s).toMatch(/could not be counted just now/);
    expect(s).toMatch(/unknown rather than none/);
  });

  it('a half-drawn graph reports both numbers, so the screen cannot contradict itself', () => {
    const s = graphStateSentence({ initialized: true, withEdge: 6, columnOnly: 36, coverageOk: true });
    expect(s).toMatch(/6 active employees have/);
    expect(s).toMatch(/36 more have/);
    expect(s).toMatch(/missing from the chart/);
  });

  it('a fully drawn graph says the chart came from relationships and nothing else', () => {
    const s = graphStateSentence({ initialized: true, withEdge: 42, columnOnly: 0, coverageOk: true });
    expect(s).toMatch(/from those relationships and from nothing else/);
  });
});

describe('the sentences that stop two true numbers from lying together', () => {
  it('twoSourcesSentence names both tables', () => {
    const s = twoSourcesSentence(42);
    expect(s).toMatch(/The 42 people counted above/);
    expect(s).toMatch(/employee register/);
    expect(s).toMatch(/Organization Graph/);
  });

  it('twoSourcesSentence survives an unknown headcount without printing a zero', () => {
    expect(twoSourcesSentence(null)).toMatch(/^The people counted above/);
    expect(twoSourcesSentence(null)).not.toMatch(/ 0 /);
  });

  it('noAssigneesSentence always ends with the next step', () => {
    expect(noAssigneesSentence(42)).toMatch(/42 active employee records carry/);
    expect(noAssigneesSentence(42)).toMatch(/will appear here/);
    expect(noAssigneesSentence(0)).toMatch(/No active employee record carries a reporting manager at all yet/);
    expect(noAssigneesSentence(null)).toMatch(/Set a reporting line on an employee record/);
  });
});
