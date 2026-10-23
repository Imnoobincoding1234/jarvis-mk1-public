#!/usr/bin/env node
// MolmoWeb TEXT ONLY, 2026-10-01 — for the v4 web-action data. allenai/MolmoWeb-HumanTrajs (35,971) and
// MolmoWeb-SyntheticTrajs (108,254), ODC-BY 1.0 (instructions written with Gemini / GPT — their terms apply).
// The sets are 467 GB because every row carries screenshots; jarvis-os/parquet.js reads only the
// sample_id / instruction / trajectory columns over HTTP byte ranges (~525 MB compressed in all) and no
// image is ever downloaded. Out: data/external_web/molmoweb/<set>__<file>.jsonl.gz, one row per line:
//   { set, config, file, id, instruction:{high_level,mid_level,low_level,…}, steps:[{url, action, description, thought}] }
// Screenshot file names are dropped. Resumable: a file already written is skipped.
//   node fetch_molmoweb.js            (logs to data/external_web/molmoweb/fetch.log)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const P = require('../jarvis-os/parquet');

const OUT = path.join(__dirname, 'data', 'external_web', 'molmoweb');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'fetch.log');
const log = s => { const l = '[' + new Date().toLocaleString('sv-SE') + '] ' + s; fs.appendFileSync(LOG, l + '\n'); console.log(l); };

function slim(trajJson) {
  let t; try { t = JSON.parse(trajJson); } catch (e) { return null; }
  return Object.keys(t).sort((a, b) => Number(a) - Number(b)).map(k => {
    const s = t[k] || {}, a = s.action || {}, o = s.other_obs || {}, out = a.action_output || {};
    return { url: o.url || '', action: a.action_str || '', description: a.action_description || '', thought: out.thought || '' };
  });
}

(async () => {
  for (const set of ['MolmoWeb-HumanTrajs', 'MolmoWeb-SyntheticTrajs']) {
    const meta = await (await fetch('https://huggingface.co/api/datasets/allenai/' + set)).json();
    const files = meta.siblings.map(s => s.rfilename).filter(f => f.endsWith('.parquet') && !f.includes('preview'));
    for (const f of files) {
      const out = path.join(OUT, set + '__' + path.basename(f, '.parquet') + '.jsonl.gz');
      if (fs.existsSync(out)) continue;
      const config = path.basename(f).replace(/-\d+\.parquet$/, '');
      const t0 = Date.now();
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const pq = await P.open('https://huggingface.co/datasets/allenai/' + set + '/resolve/main/' + f);
          // streamed, one row group at a time, so memory stays small beside the training run
          const tmp = out + '.part';
          const gz = zlib.createGzip(), sink = fs.createWriteStream(tmp);
          const closed = new Promise((res, rej) => { sink.on('finish', res); sink.on('error', rej); });
          gz.pipe(sink);
          let n = 0;
          for await (const r of P.rows(pq, ['sample_id', 'instruction', 'trajectory'])) {
            let ins; try { ins = JSON.parse(r.instruction); } catch (e) { ins = { text: r.instruction }; }
            const steps = slim(r.trajectory);
            if (!steps) continue;
            if (!gz.write(JSON.stringify({ set, config, file: f, id: r.sample_id, instruction: ins, steps }) + '\n')) await new Promise(r => gz.once('drain', r));
            n++;
          }
          gz.end(); await closed;
          fs.renameSync(tmp, out);
          log(set + ' ' + f + ': ' + n + ' rows, ' + Math.round(fs.statSync(out).size / 1e6) + ' MB gz, ' + Math.round((Date.now() - t0) / 1000) + ' s');
          break;
        } catch (e) {
          log(set + ' ' + f + ': attempt ' + attempt + ' failed — ' + e.message);
          if (attempt === 3) log(set + ' ' + f + ': SKIPPED after 3 attempts (rerun to retry)');
          else await new Promise(r => setTimeout(r, 15000 * attempt));
        }
      }
    }
  }
  log('done');
})().catch(e => { log('CRASH ' + (e.stack || e)); process.exit(1); });
