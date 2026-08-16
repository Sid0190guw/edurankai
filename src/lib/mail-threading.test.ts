// src/lib/mail-threading.test.ts — the threading engine, against fixtures rather than a database.
//
// The four shapes the brief names — original, reply, reply-all, forward, nested conversation — are
// each a case below, built as plain objects. assembleConversation() and splitQuoted() are pure, so
// a mis-threaded conversation shows up here rather than in somebody's inbox.
import { describe, it, expect } from 'vitest';
import {
  parseMessageIds, parentIdOf, normalizeSubject, subjectIsReply, buildReferences,
  assembleConversation, flattenConversation, splitQuoted, summarizeConversation,
  participantLine, MAX_REFERENCES, MAX_RENDER_DEPTH, type MessageLike,
} from './mail-threading';

const ID = (n: number) => '<msg' + n + '@edurankai.in>';

function msg(n: number, over: Partial<MessageLike> = {}): MessageLike {
  return {
    id: 'id-' + n,
    rfc_message_id: ID(n),
    created_at: new Date(Date.UTC(2026, 7, 1, 10, n)).toISOString(),
    subject: 'Invoice 42',
    from_email: 'anita@university.edu',
    from_name: 'Anita',
    ...over,
  };
}

describe('header parsing', () => {
  it('pulls every id out of a folded, comma-separated References', () => {
    expect(parseMessageIds('<a@x> ,\r\n <b@y>\t<c@z>')).toEqual(['<a@x>', '<b@y>', '<c@z>']);
  });
  it('de-duplicates without reordering', () => {
    expect(parseMessageIds('<a@x> <b@y> <a@x>')).toEqual(['<a@x>', '<b@y>']);
  });
  it('accepts an id a sender emitted without brackets', () => {
    expect(parseMessageIds('abc@host.example')).toEqual(['<abc@host.example>']);
  });
  it('is empty for nothing, rather than throwing', () => {
    expect(parseMessageIds('')).toEqual([]);
    expect(parseMessageIds(null)).toEqual([]);
    expect(parseMessageIds(undefined)).toEqual([]);
  });
  it('the parent is In-Reply-To when present, and the tail of References otherwise', () => {
    expect(parentIdOf('<b@y>', '<a@x> <b@y>')).toBe('<b@y>');
    expect(parentIdOf(null, '<a@x> <b@y>')).toBe('<b@y>');
    expect(parentIdOf(null, null)).toBeNull();
  });
});

describe('subject normalisation', () => {
  it('strips stacked reply and forward prefixes', () => {
    expect(normalizeSubject('Re: Fwd: RE: Invoice 42')).toBe('invoice 42');
    expect(normalizeSubject('FW: Invoice 42')).toBe('invoice 42');
  });
  it('strips a mailing-list tag', () => {
    expect(normalizeSubject('[ops] Re: Invoice 42')).toBe('invoice 42');
  });
  it('handles the numbered forms clients emit', () => {
    expect(normalizeSubject('Re[2]: Invoice 42')).toBe('invoice 42');
    expect(normalizeSubject('Re(3): Invoice 42')).toBe('invoice 42');
  });
  it('handles the non-English prefixes that reach a real mailbox', () => {
    expect(normalizeSubject('AW: Invoice 42')).toBe('invoice 42');
    expect(normalizeSubject('SV: Invoice 42')).toBe('invoice 42');
  });
  it('collapses whitespace and folds case', () => {
    expect(normalizeSubject('  Invoice   42  ')).toBe('invoice 42');
  });
  it('a subject made only of prefixes normalises to empty — which is what stops it merging', () => {
    // This is the guard that keeps every bare "Re:" in the building out of one conversation.
    expect(normalizeSubject('Re:')).toBe('');
    expect(normalizeSubject('Re: Fwd:')).toBe('');
  });
  it('terminates on a pathological subject rather than spinning', () => {
    expect(normalizeSubject('Re: '.repeat(200) + 'x')).toBe('x');
  });
  it('knows whether a prefix was there', () => {
    expect(subjectIsReply('Re: Invoice')).toBe(true);
    expect(subjectIsReply('Invoice')).toBe(false);
  });
});

describe('building the References a reply should carry', () => {
  it('appends the parent to the parent chain', () => {
    expect(buildReferences('<a@x>', '<b@y>')).toBe('<a@x> <b@y>');
  });
  it('starts a chain when there was none', () => {
    expect(buildReferences(null, '<a@x>')).toBe('<a@x>');
  });
  it('does not duplicate an id already in the chain', () => {
    expect(buildReferences('<a@x> <b@y>', '<b@y>')).toBe('<a@x> <b@y>');
  });
  it('truncates but ALWAYS keeps the root, because the root identifies the conversation', () => {
    const chain = Array.from({ length: 40 }, (_, i) => ID(i)).join(' ');
    const out = buildReferences(chain, ID(99)).split(' ');
    expect(out.length).toBe(MAX_REFERENCES);
    expect(out[0]).toBe(ID(0));
    expect(out[out.length - 1]).toBe(ID(99));
  });
});

describe('conversation shape', () => {
  it('an original with no replies is a single root', () => {
    const roots = assembleConversation([msg(1)]);
    expect(roots.length).toBe(1);
    expect(roots[0].via).toBe('root');
    expect(roots[0].children).toEqual([]);
  });

  it('a reply hangs off the message it answers', () => {
    const roots = assembleConversation([
      msg(1),
      msg(2, { in_reply_to: ID(1), subject: 'Re: Invoice 42' }),
    ]);
    expect(roots.length).toBe(1);
    expect(roots[0].children.length).toBe(1);
    expect(roots[0].children[0].via).toBe('in-reply-to');
    expect(roots[0].children[0].depth).toBe(1);
  });

  it('a reply-all to an OLDER message nests under that message, not at the bottom', () => {
    const roots = assembleConversation([
      msg(1),
      msg(2, { in_reply_to: ID(1) }),
      msg(3, { in_reply_to: ID(1), references_header: ID(1) }),
    ]);
    expect(roots.length).toBe(1);
    expect(roots[0].children.map((c) => c.message.id)).toEqual(['id-2', 'id-3']);
  });

  it('a nested exchange keeps its depth', () => {
    const roots = assembleConversation([
      msg(1),
      msg(2, { in_reply_to: ID(1) }),
      msg(3, { in_reply_to: ID(2) }),
      msg(4, { in_reply_to: ID(3) }),
    ]);
    const flat = flattenConversation(roots);
    expect(flat.map((n) => n.depth)).toEqual([0, 1, 2, 3]);
    expect(flat.map((n) => n.message.id)).toEqual(['id-1', 'id-2', 'id-3', 'id-4']);
  });

  it('depth is capped so a runaway chain cannot indent off the screen', () => {
    const chain: MessageLike[] = [msg(0)];
    for (let i = 1; i < 20; i++) chain.push(msg(i, { in_reply_to: ID(i - 1) }));
    const deepest = Math.max(...flattenConversation(assembleConversation(chain)).map((n) => n.depth));
    expect(deepest).toBe(MAX_RENDER_DEPTH);
  });

  it('References alone attaches a message whose direct parent is missing from this mailbox', () => {
    // The middle message never reached this mailbox — bcc, or a list that dropped it.
    const roots = assembleConversation([
      msg(1),
      msg(3, { in_reply_to: ID(2), references_header: ID(1) + ' ' + ID(2) }),
    ]);
    expect(roots.length).toBe(1);
    expect(roots[0].children[0].via).toBe('references');
  });

  it('a reply claiming an ancestor we do not hold at all still joins the conversation', () => {
    const roots = assembleConversation([
      msg(1),
      msg(2, { in_reply_to: '<somewhere-else@example.com>' }),
    ]);
    expect(roots.length).toBe(1);
    expect(roots[0].children[0].via).toBe('sequence');
  });

  it('a forward with no headers at all is its own root — it is a new conversation here', () => {
    const roots = assembleConversation([
      msg(1),
      msg(2, { subject: 'Fwd: Invoice 42', in_reply_to: null, references_header: null }),
    ]);
    expect(roots.length).toBe(2);
  });

  it('a forged self-referencing header does not recurse forever', () => {
    const roots = assembleConversation([msg(1, { in_reply_to: ID(1) })]);
    expect(roots.length).toBe(1);
    expect(roots[0].via).toBe('root');
  });

  it('a two-message cycle is broken rather than trusted', () => {
    const roots = assembleConversation([
      msg(1, { in_reply_to: ID(2) }),
      msg(2, { in_reply_to: ID(1) }),
    ]);
    expect(flattenConversation(roots).length).toBe(2);
  });

  it('everything given back is everything given in — no message is lost to the tree', () => {
    const input = [msg(1), msg(2, { in_reply_to: ID(1) }), msg(3, { in_reply_to: '<gone@x>' }), msg(4)];
    expect(flattenConversation(assembleConversation(input)).length).toBe(input.length);
  });
});

describe('quoted content', () => {
  it('finds the Gmail-style attribution line', () => {
    const s = splitQuoted('Yes, that works.\n\nOn 1 August 2026, Anita wrote:\n> the original\n> more');
    expect(s.visible).toBe('Yes, that works.');
    expect(s.marker).toBe('wrote');
    expect(s.quoted).toContain('the original');
  });

  it('finds a bare chevron block', () => {
    const s = splitQuoted('Agreed.\n> earlier text');
    expect(s.visible).toBe('Agreed.');
    expect(s.marker).toBe('chevron');
  });

  it('finds the Outlook separator', () => {
    const s = splitQuoted('Noted.\n\n-----Original Message-----\nFrom: Anita');
    expect(s.visible).toBe('Noted.');
    expect(s.marker).toBe('original-message');
  });

  it('finds an Outlook header block only when it really is one', () => {
    const real = splitQuoted('See below.\nFrom: Anita\nSent: Monday\nTo: Accounts');
    expect(real.marker).toBe('header-block');
    // A message that merely starts with the word "From:" is not a quote.
    const notAQuote = splitQuoted('From: the accounts team, a quick note about the invoice.');
    expect(notAQuote.marker).toBeNull();
    expect(notAQuote.quoted).toBe('');
  });

  it('a signature is the sender OWN writing and is kept out of the hidden part', () => {
    const s = splitQuoted('Thanks.\n\n-- \nAnita\nRegistrar');
    expect(s.signature).toContain('Anita');
    expect(s.quoted).toBe('');
    expect(s.visible).toBe('Thanks.');
  });

  it('hides nothing when nothing matches — a reading pane must not eat messages', () => {
    const s = splitQuoted('Just a plain message with no quoting in it at all.');
    expect(s.quoted).toBe('');
    expect(s.marker).toBeNull();
    expect(s.visible).toContain('plain message');
  });

  it('is safe on empty input', () => {
    expect(splitQuoted('').visible).toBe('');
    expect(splitQuoted(null).marker).toBeNull();
  });
});

describe('the conversation header', () => {
  const convo: MessageLike[] = [
    msg(1, { is_read: true, from_email: 'anita@university.edu', from_name: 'Anita Rao' }),
    msg(2, { is_read: true, from_email: 'me@edurankai.in', from_name: 'Sid', recipients: [{ kind: 'to', email: 'anita@university.edu', name: 'Anita Rao' }] }),
    msg(3, { is_read: false, from_email: 'ravi@university.edu', from_name: 'Ravi K' }),
  ];

  it('counts what is actually there', () => {
    const s = summarizeConversation(convo);
    expect(s.messageCount).toBe(3);
    expect(s.unreadCount).toBe(1);
    expect(s.subject).toBe('Invoice 42');
  });

  it('lists participants most-active first, and includes people only addressed', () => {
    const s = summarizeConversation(convo);
    expect(s.participants[0].email).toBe('anita@university.edu');
    expect(s.participants.map((p) => p.email)).toContain('me@edurankai.in');
  });

  it('opens the latest message and every unread one, and nothing else', () => {
    const s = summarizeConversation(convo);
    expect(s.expandedIds).toContain('id-3');
    expect(s.expandedIds).not.toContain('id-1');
  });

  it('a draft in the conversation always starts open', () => {
    const s = summarizeConversation([...convo, msg(4, { is_draft: true, is_read: true })]);
    expect(s.expandedIds).toContain('id-4');
  });

  it('names the people, then counts the rest', () => {
    const many = [
      { email: 'a@x', name: 'Anita Rao', sent: 3 },
      { email: 'b@x', name: 'Ravi K', sent: 2 },
      { email: 'c@x', name: 'Priya S', sent: 1 },
      { email: 'd@x', name: 'Meera T', sent: 1 },
      { email: 'e@x', name: 'Arun P', sent: 1 },
    ];
    expect(participantLine(many)).toBe('Anita, Ravi, Priya and 2 others');
    expect(participantLine(many.slice(0, 2))).toBe('Anita, Ravi');
  });

  it('an empty conversation summarises without throwing', () => {
    const s = summarizeConversation([]);
    expect(s.messageCount).toBe(0);
    expect(s.subject).toBe('(no subject)');
    expect(s.expandedIds).toEqual([]);
  });
});
