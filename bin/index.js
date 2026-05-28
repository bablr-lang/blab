/* global process crypto Buffer Uint8Array */
import '@bablr/agast-helpers/debug/register';
import '@bablr/record';
import { program } from 'commander';
import { readFile, readDir, decodeUTF8 } from '@bablr/fs';
import { streamParse } from 'bablr';
import * as Tags from '@bablr/agast-helpers/tags';
import * as BList from '@bablr/agast-helpers/b-list';
import {
  evaluateReturn,
  StreamIterable,
  wait,
  continue_,
  getStreamIterator,
  streamFromTree,
  prettyGroupTags,
  stringFromStream,
} from '@bablr/agast-helpers/stream';
import {
  printAttributes,
  printNodeFlags,
  printNodeType,
  printString,
  printTag,
  printType,
} from '@bablr/agast-helpers/print';
import { buildPropertyTag, parseTag, parseTagType } from '@bablr/agast-helpers/builders';
import {
  CloseNodeTag,
  GapTag,
  NullTag,
  OpenNodeTag,
  ReferenceTag,
} from '@bablr/agast-helpers/symbols';
import { buildNode, Path, propertyIsFull } from '@bablr/agast-helpers/path';
import { m } from '@bablr/helpers/grammar';
import { arrayValues } from '@bablr/agast-helpers/iterable';
import { freeze } from '@bablr/agast-helpers/object';

let subtleCrypto = crypto.subtle;
let digest_ = subtleCrypto.digest;
let digest = (str) => digest_.call(subtleCrypto, 'SHA-512', Buffer.from(str));

export const printOpenNodeTag = (tag) => {
  if (tag?.type !== OpenNodeTag) throw new Error();

  let { flags, type, name, literalValue, attributes, selfClosing } = tag.value;

  if (literalValue && !selfClosing) throw new Error();
  let selfClosingFrag = selfClosing ? '/' : '';
  let literalFrag = literalValue ? `${printString(literalValue)}` : '';

  let printedAttributes = printAttributes(attributes);
  let attributesFrag = printedAttributes ? `${printedAttributes}` : '';
  let typeFrag = type ? printNodeType(type) : '';
  let nameFrag = name ? printType(name) : '';

  return `<${printNodeFlags(
    flags,
  )}${typeFrag}${nameFrag}${literalFrag}${attributesFrag}${selfClosingFrag}>`;
};

export const vcsPrintTag = (tag) => {
  if (parseTagType(tag) === OpenNodeTag) {
    return printOpenNodeTag(parseTag(tag));
  } else {
    return printTag(tag);
  }
};

function* __generateCSTML(tags, options) {
  if (!tags) {
    yield* 'null';
    return;
  }

  let prevTagType = null;
  let iter = getStreamIterator(prettyGroupTags(tags));
  let step;

  for (;;) {
    step = iter.next();
    while (step === null || step instanceof Promise) {
      if (step === null) yield continue_(), (step = iter.next());
      if (step instanceof Promise) step = yield wait(step);
    }
    if (step.done) break;

    const tag = step.value;
    let tagType = parseTagType(tag);

    if (tagType === ReferenceTag && prevTagType === NullTag) {
      yield* ' ';
    }

    if (tagType === 'Effect') {
      continue;
    }

    yield* vcsPrintTag(tag);

    prevTagType = tagType;
  }
}

export const generateCSTML = (tags, options = freeze({})) =>
  new StreamIterable(__generateCSTML(tags, options));

export const vcsPrintCSTML = (tags) => {
  return stringFromStream(generateCSTML(tags));
};

// TODO move this somewhere else
export function* vcsPrint(node) {
  let str = vcsPrintCSTML(streamFromTree(node));
  let hash = yield wait(digest(str));

  return `${Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .slice(0, 2)
    .join('')}: ${str}`;
}

function* __init(options, rootDir) {
  const { default: language } = yield wait(import(options.language));

  let dirIter = getStreamIterator(readDir(rootDir));
  let dirStep;
  for (;;) {
    dirStep = dirIter.next();
    while (dirStep === null || dirStep instanceof Promise) {
      if (dirStep === null) yield continue_(), (dirStep = dirIter.next());
      if (dirStep instanceof Promise) dirStep = yield wait(dirStep);
    }

    if (dirStep.done) break;

    let file = `${rootDir}/${dirStep.value.name}`;
    let stack = [];
    let nodePath = null;

    const matcher = options.matcher
      ? m({ raw: [options.matcher] })
      : options.production
      ? m`<${options.production} />`
      : language.defaultMatcher;

    let streamIter = getStreamIterator(streamParse(language, matcher, decodeUTF8(readFile(file))));
    let streamStep;
    for (;;) {
      streamStep = streamIter.next();
      while (streamStep === null || streamStep instanceof Promise) {
        if (streamStep === null) yield continue_(), (streamStep = streamIter.next());
        if (streamStep instanceof Promise) streamStep = yield wait(streamStep);
      }

      if (streamStep.done) break;

      let strTag = streamStep.value;
      let tag = parseTag(strTag);

      let isOpen = tag.type === OpenNodeTag;
      let isClose = tag.type === CloseNodeTag;

      if (isOpen) {
        if (nodePath) stack.push(nodePath);
        nodePath = Path.fromTag(tag);
      }

      if (tag.type === GapTag || tag.type === NullTag) {
        nodePath = nodePath.advance(Path.fromTag(strTag).node);
      } else if (!isOpen && !isClose) {
        nodePath = nodePath.advance(strTag);
      }

      if (isClose || (isOpen && tag.value.selfClosing)) {
        if (isClose) {
          nodePath = nodePath.advance(strTag);
        }
        let finishedNode = nodePath.node;

        let intrinsic = false;
        if (stack.length) {
          nodePath = stack.pop();

          let property = nodePath.getChild(-1);

          intrinsic =
            (!propertyIsFull(property) && property.value.reference?.flags.intrinsic) ||
            ['#', '@'].includes(property.value.reference?.type);
          nodePath = nodePath.advance(intrinsic ? finishedNode : Path.fromTag('<//>').node);
        }

        if (!intrinsic) {
          let children = Tags.getValues(Tags.getTags(finishedNode))[1] || Tags.fromValues([]);

          if (Tags.getDepth(children) === 1) {
            console.log(yield* vcsPrint(finishedNode));
          } else {
            let tree = children;
            let newTree = Tags.fromValues([]);
            let stack = [];
            while (tree) {
              let idx = Tags.getSize(newTree);
              if (idx < Tags.getSize(tree)) {
                stack.push({ tree, newTree });
                tree = Tags.getValues(tree)[idx];
                newTree = Tags.getDepth(tree) > 1 ? Tags.fromValues([]) : tree;
              } else {
                let _finishedTree = tree;
                let finishedNewTree = newTree;

                let frame = stack.pop();
                tree = frame.tree;
                newTree = frame.newTree;

                let tags_ = BList.fromValues(
                  ['__:', Tags.fromValues([]), Path.fromTag('<//>').node /*, hashTag */],
                  1,
                );
                let newProperty = buildPropertyTag(tags_);

                console.log(yield* vcsPrint(buildNode(Tags.from('<__>', finishedNewTree, '</>'))));

                newTree = Tags.push(newProperty, newTree);
              }
            }
          }
        }
      }
    }
  }
}

const init = (options, rootDir = '.') => {
  return evaluateReturn(new StreamIterable(__init(options, rootDir)));
};

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
