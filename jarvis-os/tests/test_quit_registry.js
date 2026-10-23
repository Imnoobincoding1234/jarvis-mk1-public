// QUIT ONLY AN APP THAT EXISTS (2026-10-17, the round-8 gate). close_app put names no installed app answers to straight on a card —
// "Quit lmaooo, sir? Please confirm." — while open, switch_to and hide already refused under the matcher's 0.5 bar. Now close
// refuses too, before any card, unless something by that name is running. The matcher (fuzzyApp) and its bar are unchanged; this
// reads the installed apps the way fuzzyApp does and never runs osascript.
'use strict';
const fs = require('fs');
const path = require('path');
const SC = require(path.join(__dirname, '..', 'system_control.js'));
let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
}
console.log('— the gate\'s quit look-alikes name no app (score under 0.5) —');
for (const q of ['lmaooo', 'aankhen', 'every app', 'everything except brave', 'that app']) eq('“' + q + '”', SC.fuzzyApp(q).score < 0.5, true);
console.log('\n— real apps still match —');
const apps = fs.readdirSync('/Applications').filter(n => n.endsWith('.app')).map(n => n.slice(0, -4));
if (apps.includes('Safari') || fs.existsSync('/System/Applications/Safari.app') || fs.existsSync('/Applications/Safari.app')) eq('“safari”', SC.fuzzyApp('safari').score >= 0.5, true);
eq('“terminal”', SC.fuzzyApp('terminal').score >= 0.5, true);
console.log('\n— close_app refuses before the card —');
const S = fs.readFileSync(path.join(__dirname, '..', 'system_control.js'), 'utf8');
const body = S.slice(S.indexOf('async function close_app'), S.indexOf('async function', S.indexOf('async function close_app') + 10));
const refuse = body.indexOf("if (m.score < 0.5 && !a.known && (await appRunning(name)) !== true)"), card = body.indexOf("confirm('close_app'");
eq('the refusal comes before any confirm card', refuse > 0 && card > refuse, true);
eq('it says there is no such app', /There is no app called “' \+ String\(name \|\| ''\)\.trim\(\) \+ '” on this Mac, sir\./.test(body), true);
eq('a running app outside the folders is still offered (only a definite true lets it through)', /!== true\)/.test(body), true);
const R = fs.readFileSync(path.join(__dirname, '..', 'readmodel.js'), 'utf8');
eq('a name the reader\'s registry knows (app, browser, site with an app) is marked known — "close spotify" keeps its card', /\{ type: 'close_app', name, target: name, force: !!r\.force, known: true \}/.test(R), true);
eq('a name nothing knows is not marked (it gets the honest "no app called …")', /if \(!t\) return gate\(text, kind, r, \{ type: 'close_app', name, target: name, force: !!r\.force \}\);/.test(R), true);
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
