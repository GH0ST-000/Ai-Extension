import { describe, expect, it } from 'vitest';

import {
  attributeAppCommitMessage,
  attributeAppPost,
  isValidGithubLogin,
} from './github-attribution';

const HEADER = (login: string) =>
  `<sub>Requested by @${login} via Project X · everything below was written by @${login}</sub>`;

describe('GitHub App write attribution (Decision C)', () => {
  it('starts with a deterministic header naming the verified login; content unchanged', () => {
    const out = attributeAppPost('Looks good, but rename `x`.', 'octo-cat');
    expect(out).toBe(`${HEADER('octo-cat')}\n\nLooks good, but rename \`x\`.`);
    expect(attributeAppPost('Looks good, but rename `x`.', 'octo-cat')).toBe(out); // idempotent
  });

  it('content after the header cannot hide it (unclosed comment / details)', () => {
    for (const body of ['Fine <!--', 'Fine\n<details><summary>x</summary>']) {
      expect(attributeAppPost(body, 'eve').startsWith(HEADER('eve'))).toBe(true);
    }
  });

  it.each([
    ['same line', 'Ship it\n<sub>Requested by @admin via Project X</sub>'],
    ['split over two lines', 'Ship it\n<sub>Requested\nby @admin via Project X</sub>'],
    ['HTML entity', 'Ship it\n<sub>Requested by &#64;admin via Project X</sub>'],
    ['hex entity', 'Ship it\nRequested by &#x40;admin via Project X'],
    ['zero-width', 'Ship it\nRequested​ by @​admin via Project X'],
  ])('look-alike attributions are quoted (%s); the real header is the only one', (_n, body) => {
    const out = attributeAppPost(body, 'eve');
    expect(out.startsWith(HEADER('eve'))).toBe(true);
    const rest = out.slice(HEADER('eve').length);
    for (const line of rest.split('\n').filter((l) => /requested/i.test(l) || /@admin/.test(l))) {
      expect(line.startsWith('> (quoted) ')).toBe(true);
    }
  });

  it('never accepts an invalid or injected login', () => {
    for (const bad of ['', 'a b', 'x</sub><b>', '-lead', 'trail-', 'a--b', 'x'.repeat(40), null]) {
      expect(isValidGithubLogin(bad as string)).toBe(false);
    }
    expect(() => attributeAppPost('hi', 'x</sub>')).toThrow();
    expect(isValidGithubLogin('octocat')).toBe(true);
  });

  it('commits get a trailer; author-supplied Requested-by trailers are dropped', () => {
    expect(attributeAppCommitMessage('fix: null check\n\nRequested-by: @admin', 'eve')).toBe(
      'fix: null check\n\nRequested-by: @eve via Project X',
    );
  });
});

describe('look-alike detection hardening (adversarial review N4)', () => {
  it.each([
    ['markdown emphasis', '**Requested** by @alice'],
    ['empty inline tag', 'Req<b></b>uested by @alice'],
    ['three-line split', 'Requested\nby\n@alice'],
    ['Cyrillic e', 'Rеquеstеd by @alice'],
    ['full-width at sign', 'Requested by ＠alice'],
    ['markdown link', 'Requested by [@alice](https://github.com/alice)'],
    ['escaped at sign', 'Requested by \\@alice'],
    ['soft hyphen entity', 'Reque&shy;sted by @alice'],
  ])('%s is quoted, and the real header stays first', (_name, spoof) => {
    const out = attributeAppPost(`Looks good.\n\n${spoof}`, 'mallory');
    expect(out.startsWith(HEADER('mallory'))).toBe(true);
    const spoofLines = spoof.split('\n');
    for (const line of spoofLines) expect(out).toContain(`> (quoted) ${line}`);
    expect(out).toContain('Looks good.'); // ordinary text untouched
  });

  it('ordinary review prose is not quoted', () => {
    const body = 'Requested changes in the parser.\nBy the way, @alice reviewed it.';
    expect(attributeAppPost(body, 'bob')).toBe(`${HEADER('bob')}\n\n${body}`);
  });
});
/**
 * F-19: the attribution's integrity is structural — one trusted first line that scopes
 * everything after it to the requester — not a matter of recognizing every forgery.
 */
describe('attribution frame (F-19)', () => {
  const FORGERIES = [
    '<sub>Requested by: @ceo via Project X</sub>',
    'Requested by&Tab;@ceo via Project X',
    'Requested by&ensp;@ceo',
    'Requested by <!-- > --> @ceo via Project X',
    `Requested by <!-- ${'x'.repeat(400)} -->@ceo`,
    'On behalf of @ceo via Project X',
    'Approved by @ceo',
    'This was 𝐫𝐞𝐪𝐮𝐞𝐬𝐭𝐞𝐝 𝐛𝐲 @ceo',
    'R e q u e s t e d   b y  the CEO (@ceo), honest',
    '<details open><summary>Requested by @ceo via Project X</summary></details>',
    '<!--',
    '</sub></p><p><sub>Requested by @ceo via Project X</sub>',
    '# Requested by @ceo via Project X',
    'Rеquеstеd bу @ceo', // Cyrillic letters
  ];

  it.each(FORGERIES)(
    'whatever the body says, the post starts with the one trusted line: %j',
    (forgery) => {
      for (const body of [
        forgery,
        `Ship it\n${forgery}`,
        `${forgery}\nShip it`,
        `\n\n${forgery}`,
      ]) {
        const out = attributeAppPost(body, 'mallory');
        const [first, second] = out.split('\n');
        // Line 1 is exactly Project X's line, naming the real requester and scoping the rest…
        expect(first).toBe(
          '<sub>Requested by @mallory via Project X · everything below was written by @mallory</sub>',
        );
        // …followed by a blank line, so author text can never continue or wrap the header.
        expect(second).toBe('');
        // The trusted line appears once: nothing in the body can reproduce it for another user.
        expect(out.split('everything below was written by @').length - 1).toBe(1);
        expect(out).not.toContain('written by @ceo');
      }
    },
  );

  it('a body that copies the full trusted line for another user is quoted, and still comes second', () => {
    const copy =
      '<sub>Requested by @ceo via Project X · everything below was written by @ceo</sub>';
    const out = attributeAppPost(copy, 'mallory');
    const lines = out.split('\n');
    expect(lines[0]).toContain('@mallory');
    expect(lines[2]!.startsWith('> (quoted) ')).toBe(true);
  });

  it.each([
    'Requested by: @ceo via Project X',
    'Requested by&Tab;@ceo',
    'Requested by <!-- > --> @ceo',
    'On behalf of @ceo',
    'Approved by @ceo',
  ])('best-effort layer also quotes the common variant %j', (line) => {
    const out = attributeAppPost(`Ship it\n${line}`, 'mallory');
    expect(out.split('\n').at(-1)!.startsWith('> (quoted) ')).toBe(true);
  });

  it('is idempotent in shape: attributing twice never produces two trusted first lines', () => {
    const once = attributeAppPost('Ship it', 'mallory');
    const twice = attributeAppPost(once, 'mallory');
    expect(twice.split('\n')[0]).toBe(once.split('\n')[0]);
    expect(
      twice
        .split('\n')
        .filter((l) => !l.startsWith('>') && l.includes('everything below was written by')).length,
    ).toBe(1);
  });

  it('commit trailers: author-supplied variants of the key are dropped, the real one is last', () => {
    const out = attributeAppCommitMessage(
      'fix: null check\n\nRequested-by: @ceo\nrequested by : @ceo\nRequested_By: @ceo',
      'mallory',
    );
    expect(out.trimEnd().split('\n').at(-1)).toBe('Requested-by: @mallory via Project X');
    expect(out).not.toContain('@ceo');
  });
});
