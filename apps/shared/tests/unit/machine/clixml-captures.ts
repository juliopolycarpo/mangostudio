/**
 * Stderr captured from Windows PowerShell 5.1 (build 26100, pt-BR) started as
 * `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ...` with
 * stdout and stderr piped, running `Write-Progress -Activity act -Status st; throw
 * 'boom-after-progress'`: a progress record first, then the error. The envelope is what an
 * operator saw before `decodeClixml`.
 */
export const CAPTURED_PROGRESS_THEN_THROW = [
  '#< CLIXML',
  '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
    '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN>' +
    '<MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparando módulos para primeiro uso.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>' +
    '<S S="Error">boom-after-progress_x000D__x000A_</S>' +
    '<S S="Error">No linha:1 caractere:113_x000D__x000A_</S>' +
    '<S S="Error">+ ...  Write-Progress -Activity act -Completed; throw \'boom-after-progress\'_x000D__x000A_</S>' +
    '<S S="Error">+                                               ~~~~~~~~~~~~~~~~~~~~~~~~~~~_x000D__x000A_</S>' +
    '<S S="Error">    + CategoryInfo          : OperationStopped: (boom-after-progress:String) [], RuntimeException_x000D__x000A_</S>' +
    '<S S="Error">    + FullyQualifiedErrorId : boom-after-progress_x000D__x000A_</S>' +
    '<S S="Error"> _x000D__x000A_</S></Objs>',
].join('\r\n');

/** What `CAPTURED_PROGRESS_THEN_THROW` decodes to: the script's message, position and category. */
export const CAPTURED_PROGRESS_THEN_THROW_TEXT =
  'boom-after-progress\r\n' +
  'No linha:1 caractere:113\r\n' +
  "+ ...  Write-Progress -Activity act -Completed; throw 'boom-after-progress'\r\n" +
  '+                                               ~~~~~~~~~~~~~~~~~~~~~~~~~~~\r\n' +
  '    + CategoryInfo          : OperationStopped: (boom-after-progress:String) [], RuntimeException\r\n' +
  '    + FullyQualifiedErrorId : boom-after-progress\r\n' +
  ' \r\n';
