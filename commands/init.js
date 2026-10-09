/* global crypto Buffer Uint8Array btoa */
import '@bablr/agast-helpers/debug/register';
import { arrayValues, freezeRecord } from '@bablr/record';
import { basename } from 'node:path';

import { readFile, decodeUTF8 } from '@bablr/fs';
import { readDir } from '@bablr/fs-cstml';
import { streamParse } from 'bablr';
import * as Tags from '@bablr/agast-helpers/tags';
import * as BList from '@bablr/agast-helpers/b-list';
import {
  evaluateReturn,
  StreamIterable,
  wait,
  continue_,
  getStreamIterator,
} from '@bablr/agast-helpers/iterable';

import { streamFromTree, printCSTML, hoist, treeFromStream } from '@bablr/agast-helpers/stream';

import {
  BindingTag,
  CloseNodeTag,
  GapTag,
  NullTag,
  OpenNodeTag,
  ReferenceTag,
  ShiftTag,
} from '@bablr/agast-helpers/symbols';
import {
  buildSumsForNode,
  flagsForSigilTag,
  getOpenTag,
  Path,
  propertyIsFull,
} from '@bablr/agast-helpers/path';
import { m, o } from '@bablr/helpers/grammar';
import { arrayLast, freeze, isObject } from '@bablr/agast-helpers/object';
import { parseTag, buildReferenceTag, printObject, printSums, printTag } from 'agast';

import { finished } from 'node:stream';

let subtleCrypto = crypto.subtle;
let digest_ = subtleCrypto.digest;
let digest = (str) => digest_.call(subtleCrypto, 'SHA-512', Buffer.from(str));
let porcelain = freezeRecord({ porcelain: true });

// TODO move this somewhere else
let hashNode = async (str) => {
  let hash = await digest(str);

  return btoa(
    Array.from(new Uint8Array(hash), (byte) => String.fromCodePoint(byte)).join(''),
  ).slice(0, 4);
};

let vcsPrint = (tree) => {
  return printCSTML(
    streamFromTree(tree, freezeRecord({ unshift: true, sums: true })),
    freezeRecord({ porcelain: true }),
  );
};

let walkTree = (rootDir, options = {}) => {
  return new StreamIterable(__walkTree(rootDir, options));
};

function* __walkTree(rootDir, options) {
  let { default: language } = yield wait(import(options.language));

  let dirIter = getStreamIterator(readDir(rootDir, { porcelain: true }));
  let dirStep;
  let name;
  let path = [];
  let names = [];
  let ref = null;
  let fileBinding = false;
  for (;;) {
    dirStep = dirIter.next();
    while (dirStep === null || dirStep instanceof Promise) {
      if (dirStep === null) yield continue_(), (dirStep = dirIter.next());
      if (dirStep instanceof Promise) dirStep = yield wait(dirStep);
    }

    if (dirStep.done) break;

    let tag_ = dirStep.value;
    let tag = parseTag(tag_);

    if (tag.type === ReferenceTag) {
      ref = tag;
      if (tag.value.name) {
        ({ name } = tag.value);

        yield tag_;
      }
    } else if (tag.type === OpenNodeTag) {
      path.push(tag);

      if (name && tag.value.name === Symbol.for('Dir')) {
        names.push(name);
      }
      if (!tag.value.type) {
        yield tag_;
      }
    } else if (tag.type === CloseNodeTag) {
      let open = path.pop();
      if (open.value.name === Symbol.for('Dir')) {
        names.pop();
      }
      if (!open.value.type) {
        yield tag_;
      }
    } else if (tag.type === BindingTag) {
      if (tag.value.name === Symbol.for('File')) {
        fileBinding = true;
      } else {
        throw new Error();
      }
    } else if (tag.type === GapTag) {
      if (fileBinding) {
        yield ':File:';
        yield `<{File} ${printObject({ schema: language.canonicalURL })}>`;
        yield 'content:';

        let matcher = options.matcher
          ? m({ raw: [options.matcher] })
          : options.production
          ? m`<${options.production} />`
          : language.defaultMatcher;

        let streamIter = getStreamIterator(
          hoist(
            streamParse(
              language,
              matcher,
              decodeUTF8(readFile(`${rootDir}/${names.join('/')}/${name}`)),
            ),
          ),
        );

        let streamStep;
        for (;;) {
          streamStep = streamIter.next();
          while (streamStep === null || streamStep instanceof Promise) {
            if (streamStep === null) yield continue_(), (streamStep = streamIter.next());
            if (streamStep instanceof Promise) streamStep = yield wait(streamStep);
          }

          if (streamStep.done) break;

          yield streamStep.value;
        }

        yield '</>';
      } else {
        yield* __walkTree(`${rootDir}/${ref.value.name}`, options);
      }

      fileBinding = false;
    } else {
      yield tag_;
    }
  }
}

const repoify = (options, rootDir = '.') => {
  return new StreamIterable(__repoify(options, rootDir));
};

function* __repoify(options, rootDir) {
  let iter = getStreamIterator(walkTree(rootDir, options));

  let stack = [];
  let gaps = 0;
  let nodePath = null;
  let finishedNode = null;
  let finishedHash = null;
  let shifting = false;

  yield '<[__]>';

  for (;;) {
    let step = iter.next();
    while (step === null || step instanceof Promise) {
      if (step === null) yield continue_(), (step = iter.next());
      if (step instanceof Promise) step = yield wait(step);
    }
    if (step.done) break;

    let strTag = step.value;
    let tag = parseTag(strTag);

    console.log(strTag);

    let isOpen = tag.type === OpenNodeTag;
    let isClose = tag.type === CloseNodeTag;

    if (isOpen) {
      if (nodePath) stack.push({ nodePath, gaps });
      nodePath = Path.fromTag(printTag(tag, porcelain));
    }

    if (tag.type === ShiftTag) {
      shifting = true;
    }

    if (tag.type === GapTag) {
      ++gaps;
    }

    if (tag.type === GapTag && shifting) {
      shifting = false;
      nodePath = nodePath.advance(`##${finishedHash}##`);
      nodePath = nodePath.advance(`<//>`);
    } else if (tag.type === GapTag || tag.type === NullTag) {
      nodePath = nodePath.advance(Tags.from(strTag));
    } else if (!isOpen && !isClose) {
      nodePath = nodePath.advance(strTag);
    }

    if (isClose || (isOpen && tag.value.selfClosing)) {
      if (isClose) {
        nodePath = nodePath.advance(strTag);
      }
      finishedNode = nodePath.node;

      let intrinsic = false;

      let property = stack.length ? arrayLast(stack).nodePath.childAt(-1) : null;
      let ref = parseTag(property[0]);

      intrinsic =
        isObject(property) &&
        ((!propertyIsFull(property) && ref.value.flags.intrinsic) ||
          ['#', '@'].includes(ref.value.type));

      let hash = null;
      if (!intrinsic) {
        let newTags = [];
        // let children = finishedNode || Tags.create();

        let tree = finishedNode;
        let newTree = Tags.fromValues([tree[0]]);
        let idx = 0;
        let treeStack = [];

        while (tree) {
          if (Tags.getDepth(tree) > 1 && idx < tree.length) {
            treeStack.push({ tree, newTree, idx: idx + 1 });
            tree = tree[idx];
            newTree = Tags.fromValues([tree[0]]);
            idx = 0;
          } else {
            let _finishedTree = tree;
            let finishedNewTree = Tags.getDepth(tree) === 1 ? tree : Tags.push('</>', newTree);

            let frame = Tags.getDepth(tree) ? treeStack.pop() : null;

            let node = finishedNewTree;
            let str = vcsPrint(node);

            hash = yield wait(hashNode(str));
            yield `##${hash}##`;
            yield* streamFromTree(node, freezeRecord({ sums: true }));
            finishedHash = hash;

            if (frame) {
              ({ tree, newTree, idx } = frame);

              let gapNode = Tags.fromValues(['<//>']);

              let tags_ = Tags.fromValues([
                '__:',
                '',
                `##${hash}##`,
                printSums(Tags.sumNode(_finishedTree)),
                gapNode,
              ]);
              let newProperty = tags_;

              newTree = Tags.push(newProperty, newTree);
            } else {
              break;
            }
          }
        }
      }

      if (!stack.length) break;

      ({ nodePath, gaps } = stack.pop());

      if (intrinsic) {
        nodePath = nodePath.advance(finishedNode);
      } else {
        let hashTag = `##${finishedHash}##`;
        // yield hashTag;
        nodePath = nodePath.advance(hashTag);
        nodePath = nodePath.advance(buildSumsForNode(finishedNode));
        // yield '<//>';
        nodePath = nodePath.advance('<//>');
      }
    }
  }

  yield '</>';
}

export const init = async (options, rootDir = '.') => {
  // eslint-disable-next-line
  console.log(
    await printCSTML(repoify(options, rootDir), freezeRecord({ hoist: false, group: true })),
  );
  // console.log(await printCSTML(walkTree(rootDir, options)));
};
