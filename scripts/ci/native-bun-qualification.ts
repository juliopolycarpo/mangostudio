import {
  parseNativeQualificationArgs,
  runNativeQualification,
} from '../lib/native-bun-qualification';

if (import.meta.main) {
  try {
    const receipt = await runNativeQualification(
      parseNativeQualificationArgs(process.argv.slice(2))
    );
    process.stdout.write(`Native qualification ${receipt.status}: ${receipt.out}/receipt.json\n`);
    process.exitCode = receipt.status === 'qualified' ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `${String(error)}\nUsage: bun scripts/ci/native-bun-qualification.ts --root <checkout> --out <receipts> --sha <commit>\n`
    );
    process.exitCode = 2;
  }
}
