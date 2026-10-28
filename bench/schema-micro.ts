// Micro-benchmark: schema validation cost per message (bench S4).
//   node bench/schema-micro.ts
import { t } from '../src/schema.ts';
import { Item, User } from './api.ts';
import { user } from './api.ts';
import { bench, table } from './lib.ts';

const item = { i: 1, name: 'item', ok: true };
const u = user('42');
const Wide = t.object(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, t.number()])));
const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, i]));
console.log(
  table([
    bench('Item.parse (3 fields)', () => Item.parse(item)),
    bench('User.parse (nested, array)', () => User.parse(u)),
    bench('Wide.parse (20 numbers)', () => Wide.parse(wide)),
    bench('baseline: JSON.stringify(User)', () => JSON.stringify(u)),
  ]),
);
