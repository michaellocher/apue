//-hide
import { t } from '../../src/index.ts';
const Product = t.object({ id: t.string(), name: t.string(), price: t.number() });
//-show
import { defineApi, op } from '../../src/index.ts';

export const api = defineApi({
  'products.get': op({
    effect: 'safe',
    input: t.object({ id: t.string() }),
    output: Product,
    cache: {
      maxAge: 60,                      // Cache-Control: max-age=60 (browsers)
      staleWhileRevalidate: 600,       // …, stale-while-revalidate=600
      cdnMaxAge: 3600,                 // CDN-Cache-Control: max-age=3600 (RFC 9213)
      groups: ['products'],            // Cache-Groups: "products" (RFC 9875)
    },
  }),
  'products.update': op({
    effect: 'idempotent',
    input: Product,
    output: Product,
    invalidates: ['products'],         // Cache-Group-Invalidation: "products" on success
  }),
  'me.cart': op({
    effect: 'safe',
    input: t.void(),
    output: t.array(Product, { max: 100 }),
    cache: { maxAge: 10, private: true }, // depends on the caller: Cache-Control: private
  }),
});
