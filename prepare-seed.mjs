// Copy the committed data/ aside, before a volume can hide it.
//
//   node prepare-seed.mjs
//
// Run as part of `npm run build`, which on Railway happens during the BUILD
// phase — the only moment the committed files are reachable.
//
// A volume mounted at /app/data shadows the repository's data/ directory. The
// volume starts empty, so on the first boot after attaching one, data/snapshot.json
// and data/history.jsonl are simply gone. The history is the treasury series:
// evidence, never back-filled, and a lost reading cannot be recovered. Without
// this step, the volume added to protect that file is what destroys it.
//
// server.mjs restores anything missing from this copy at boot, and never
// overwrites a file the volume already has — once the volume holds readings,
// the volume is the record.

import { cpSync, existsSync, readdirSync } from "node:fs";

const FROM = "data";
const TO = "data-seed";

if (!existsSync(FROM)) {
  console.log(`prepare-seed: no ${FROM}/ to copy — nothing to do`);
  process.exit(0);
}

// The claim archives are bulky and are not needed to boot. Only the files the
// server and the refresh actually read are worth seeding.
const WANTED = new Set(["snapshot.json", "history.jsonl"]);

cpSync(FROM, TO, {
  recursive: true,
  filter: (src) => {
    const name = src.replace(/\\/g, "/").split("/").pop();
    return src === FROM || WANTED.has(name);
  },
});

const seeded = existsSync(TO) ? readdirSync(TO) : [];
console.log(`prepare-seed: ${TO}/ holds ${seeded.length} file(s): ${seeded.join(", ") || "(none)"}`);
