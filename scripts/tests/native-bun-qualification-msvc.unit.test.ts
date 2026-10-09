import { describe, expect, test } from 'bun:test';

import { parseNativeMsvcInventory } from '../lib/native-bun-qualification-msvc';

function installedTools(directory = 'D:\\Custom VS\\VC\\Tools\\MSVC\\14.99.12345') {
  return ['cl.exe', 'link.exe', 'vctip.exe'].map((name) => ({
    path: `${directory}\\bin\\Hostx64\\x64\\${name}`,
    fileVersion: '14.99.12346.0',
    productVersion: '14.99.12346.0',
    sha256: 'a'.repeat(64),
  }));
}

function inventory(tools = installedTools()) {
  return { os64Bit: true, process64Bit: true, installedTools: tools };
}

describe('native MSVC attestation', () => {
  test('retains installed file versions and hashes across different actual toolsets', () => {
    const tools = [
      ...installedTools(),
      ...installedTools('C:\\Program Files\\VS\\VC\\Tools\\MSVC\\14.51.36231'),
    ];
    const result = parseNativeMsvcInventory(`\uFEFF${JSON.stringify(inventory(tools))}`);
    expect(result.installedTools).toEqual(tools);
    expect(result.vctip).toEqual([tools[2], tools[5]]);
    expect(result.vctip[0].fileVersion).toBe('14.99.12346.0');
  });

  test('rejects missing or unsupported native inventory', () => {
    for (const value of [null, {}, inventory([]), { ...inventory(), process64Bit: false }])
      expect(() => parseNativeMsvcInventory(JSON.stringify(value))).toThrow(
        'expected native x64 host and nonempty installed tools'
      );
    expect(() => parseNativeMsvcInventory('partial')).toThrow(SyntaxError);
  });

  test('rejects malformed, duplicate and untrusted tool metadata', () => {
    for (const changed of [
      { path: 'relative\\vctip.exe' },
      { path: 'C:\\elsewhere\\vctip.exe' },
      { fileVersion: '' },
      { productVersion: null },
      { sha256: 'not-a-hash' },
    ]) {
      const tools = installedTools();
      const invalid = { ...tools[2], ...changed };
      expect(() =>
        parseNativeMsvcInventory(
          JSON.stringify(inventory([tools[0], tools[1], invalid] as typeof tools))
        )
      ).toThrow('expected unique absolute installed x64 tool path, versions and SHA256');
    }
    const tools = installedTools();
    expect(() =>
      parseNativeMsvcInventory(
        JSON.stringify(inventory([...tools, { ...tools[2], path: tools[2].path.toUpperCase() }]))
      )
    ).toThrow('expected unique absolute installed x64 tool path, versions and SHA256');
  });

  test('requires all installed compiler identities from the same toolset', () => {
    const tools = installedTools();
    expect(() => parseNativeMsvcInventory(JSON.stringify(inventory(tools.slice(0, 2))))).toThrow(
      'expected an independently attested VCTIP'
    );
    expect(() => parseNativeMsvcInventory(JSON.stringify(inventory([tools[2]])))).toThrow(
      'expected independently attested cl.exe, link.exe and vctip.exe'
    );
  });
});
