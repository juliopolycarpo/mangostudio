// Emit the same multibyte character in separate writes on each captured pipe.
await Bun.write(Bun.stdout, new Uint8Array([0xe2]));
await Bun.write(Bun.stderr, new Uint8Array([0xe2]));
await Bun.sleep(100);
await Bun.write(Bun.stdout, new Uint8Array([0x82, 0xac]));
await Bun.write(Bun.stderr, new Uint8Array([0x82, 0xac]));
