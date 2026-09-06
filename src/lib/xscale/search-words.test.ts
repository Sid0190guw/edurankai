// How the /careers search box turns what somebody typed into what the query looks for.
//
// THE FAULT THIS PINS. `q` used to be matched as ONE literal string — `'%' + q + '%'` ILIKE'd
// against each column — so every word of a query had to appear contiguously, in that order, inside
// a single field. Measured against the live endpoint on 2026-09-06:
//
//     q=QA         ->  9 roles
//     q=junior     -> 16 roles
//     q=QA junior  ->  0 roles
//
// "Data QA Analyst" is a Junior role. It matches both words and was returned by neither query that
// named both, because no column contains the string "QA junior". Somebody searching the two things
// they know about the job they want saw nothing, while browsing the same list showed it — which
// reads as "there are no QA roles here", not as "your phrasing was wrong".
//
// listOpportunities now requires every word to match somewhere: AND across the words, OR across the
// columns. This file asserts the splitting half of that, which is the half a test can hold without a
// database.
import { describe, it, expect } from 'vitest';
import { searchWords } from './roles-ext';

describe('searchWords', () => {
  it('splits a multi-word query into its words — the whole point', () => {
    expect(searchWords('QA junior')).toEqual(['QA', 'junior']);
  });

  it('leaves a single word exactly as it was, so existing searches answer identically', () => {
    expect(searchWords('QA')).toEqual(['QA']);
    expect(searchWords('quality')).toEqual(['quality']);
  });

  it('treats an empty or whitespace-only box as no constraint at all', () => {
    // The caller turns [] into `TRUE`. An empty filter that becomes a predicate nothing satisfies is
    // the standard way a search silently returns zero, and this file's siblings say so too.
    expect(searchWords('')).toEqual([]);
    expect(searchWords('   ')).toEqual([]);
    expect(searchWords('\t\n ')).toEqual([]);
  });

  it('collapses runs of whitespace rather than emitting empty words', () => {
    expect(searchWords('  data    qa   analyst ')).toEqual(['data', 'qa', 'analyst']);
  });

  it('deduplicates, because the same word twice is the same constraint twice', () => {
    expect(searchWords('qa QA qa')).toEqual(['qa', 'QA']);
  });

  it('preserves case, because ILIKE does the case-insensitive comparison', () => {
    // Lowercasing here would make the dedupe above claim something the SQL does not do.
    expect(searchWords('Junior QA')).toEqual(['Junior', 'QA']);
  });

  it('bounds the word count so a pasted paragraph cannot build an unbounded WHERE clause', () => {
    const pasted = 'one two three four five six seven eight nine ten';
    expect(searchWords(pasted)).toHaveLength(6);
    expect(searchWords(pasted)[0]).toBe('one');
  });

  it('survives a non-string without throwing', () => {
    expect(searchWords(undefined as any)).toEqual([]);
    expect(searchWords(null as any)).toEqual([]);
  });
});
