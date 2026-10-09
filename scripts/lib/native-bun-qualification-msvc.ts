import { win32 } from 'node:path';

interface NativeMsvcTool {
  readonly path: string;
  readonly fileVersion: string;
  readonly productVersion: string;
  readonly sha256: string;
}

export interface NativeMsvcInventory {
  readonly os64Bit: true;
  readonly process64Bit: true;
  readonly installedTools: readonly NativeMsvcTool[];
  readonly vctip: readonly NativeMsvcTool[];
}

/**
 * Validate independent installed-tool attestation before granting compiler cleanup eligibility.
 * @example const inventory = parseNativeMsvcInventory(await readFile(path, 'utf8'));
 */
export function parseNativeMsvcInventory(text: string): NativeMsvcInventory {
  const value = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (
    value?.os64Bit !== true ||
    value.process64Bit !== true ||
    !Array.isArray(value.installedTools) ||
    !value.installedTools.length
  )
    throw new Error(
      `Invalid MSVC inventory ${text}; expected native x64 host and nonempty installed tools`
    );
  const tools = new Map<string, NativeMsvcTool>();
  for (const tool of value.installedTools) {
    if (
      !tool ||
      typeof tool.path !== 'string' ||
      !win32.isAbsolute(tool.path) ||
      !/\\VC\\Tools\\MSVC\\[^\\]+\\bin\\Hostx64\\x64\\(?:cl|link|vctip)\.exe$/i.test(tool.path) ||
      typeof tool.fileVersion !== 'string' ||
      !tool.fileVersion ||
      typeof tool.productVersion !== 'string' ||
      !tool.productVersion ||
      typeof tool.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(tool.sha256) ||
      tools.has(tool.path.toLowerCase())
    )
      throw new Error(
        `Invalid MSVC tool ${JSON.stringify(tool)}; expected unique absolute installed x64 tool path, versions and SHA256`
      );
    tools.set(tool.path.toLowerCase(), tool);
  }
  const vctip = [...tools.values()].filter(
    (tool) => win32.basename(tool.path).toLowerCase() === 'vctip.exe'
  );
  if (!vctip.length)
    throw new Error(`Invalid MSVC inventory ${text}; expected an independently attested VCTIP`);
  for (const tool of vctip) {
    const directory = win32.dirname(tool.path);
    if (
      ['cl.exe', 'link.exe'].some((name) => !tools.has(win32.join(directory, name).toLowerCase()))
    )
      throw new Error(
        `Incomplete MSVC toolset ${directory}; expected independently attested cl.exe, link.exe and vctip.exe`
      );
  }
  return { os64Bit: true, process64Bit: true, installedTools: [...tools.values()], vctip };
}
