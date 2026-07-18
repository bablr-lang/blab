/* global process crypto Buffer Uint8Array btoa */
import { program } from 'commander';
import { init } from '../commands/init.js';

program
  .name('blab')
  .command('init [dir]')
  .requiredOption('-l, --language <URL>', 'The URL of the top BABLR language')
  .option('-p, --production [name]', 'Shorthand: sets the named node matcher as root matcher')
  .option('-m, --matcher [matcher]', 'Sets the root matcher')
  .option(
    '--color [WHEN]',
    'When to use ANSI escape colors \n  WHEN: "auto" | "always" | "never"',
    'auto',
  )
  .action((_, options, { args }) => init(options, args[1]))
  .parseAsync(process.argv);
