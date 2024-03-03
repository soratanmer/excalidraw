/* eslint-disable no-lone-blocks */
import {
  syncFractionalIndices,
  validateFractionalIndices,
} from "../fractionalIndex";
import { API } from "./helpers/api";
import { arrayToMap } from "../utils";
import { InvalidFractionalIndexError } from "../errors";
import { ExcalidrawElement, FractionalIndex } from "../element/types";
import { deepCopyElement } from "../element/newElement";
import { generateKeyBetween } from "fractional-indexing";

// TOFO_FI_4: consider adding benchmark for sync for 1k, 5k & 20k elements (worst & best cases)
describe("sync invalid indices with array order", () => {
  describe("should not sync empty array", () => {
    testFractionalIndicesSync({
      elements: [],
      movedElements: [],
      expect: {
        unchangedElements: [],
        validInput: true,
      },
    });

    testFractionalIndicesSync({
      elements: [],
      expect: {
        unchangedElements: [],
        validInput: true,
      },
    });
  });

  describe("should not sync when index is well defined", () => {
    testFractionalIndicesSync({
      elements: [{ id: "A", index: "a1" }],
      movedElements: [],
      expect: {
        unchangedElements: ["A"],
        validInput: true,
      },
    });

    testFractionalIndicesSync({
      elements: [{ id: "A", index: "a1" }],
      expect: {
        unchangedElements: ["A"],
        validInput: true,
      },
    });
  });

  describe("should not sync when indices are well defined", () => {
    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a1" },
        { id: "B", index: "a2" },
        { id: "C", index: "a3" },
      ],
      movedElements: [],
      expect: {
        unchangedElements: ["A", "B", "C"],
        validInput: true,
      },
    });

    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a1" },
        { id: "B", index: "a2" },
        { id: "C", index: "a3" },
      ],
      expect: {
        unchangedElements: ["A", "B", "C"],
        validInput: true,
      },
    });
  });

  describe("should sync index even if it is valid", () => {
    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a2" },
        { id: "B", index: "a4" },
      ],
      movedElements: ["A"],
      expect: {
        validInput: true,
        unchangedElements: ["B"],
      },
    });

    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a2" },
        { id: "B", index: "a4" },
      ],
      movedElements: ["B"],
      expect: {
        validInput: true,
        unchangedElements: ["A"],
      },
    });
  });

  // TODO_FI_2: likely it's not the fractional indices responsibility, double-check how to fix this
  describe("should sync indices even if they are already valid", () => {
    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a1" },
        { id: "B", index: "a0" },
        { id: "C", index: "a2" },
      ],
      movedElements: ["B", "C"],
      expect: {
        // should sync 'C' even though it's already on the top
        unchangedElements: ["A"],
      },
    });
    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a1" },
        { id: "B", index: "a0" },
        { id: "C", index: "a2" },
      ],
      movedElements: ["A", "B"],
      expect: {
        // should sync 'A', even though it's already on the bottom
        unchangedElements: ["C"],
      },
    });
    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a1" },
        { id: "B", index: "a0" },
        { id: "C", index: "a2" },
      ],
      expect: {
        unchangedElements: ["A", "C"],
      },
    });
  });

  describe("should sync when fractional index is not defined", () => {
    testFractionalIndicesSync({
      elements: [{ id: "A" }],
      movedElements: ["A"],
      expect: {
        unchangedElements: [],
      },
    });

    testFractionalIndicesSync({
      elements: [{ id: "A" }],
      expect: {
        unchangedElements: [],
      },
    });
  });

  describe("should sync when fractional indices are duplicated", () => {
    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a1" },
        { id: "B", index: "a1" },
      ],
      expect: {
        unchangedElements: ["A"],
      },
    });
    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a1" },
        { id: "B", index: "a1" },
      ],
      expect: {
        unchangedElements: ["A"],
      },
    });
  });

  describe("should sync when a fractional index is out of order", () => {
    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a2" },
        { id: "B", index: "a1" },
      ],
      movedElements: ["B"],
      expect: {
        unchangedElements: ["A"],
      },
    });

    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a2" },
        { id: "B", index: "a1" },
      ],
      movedElements: ["A"],
      expect: {
        unchangedElements: ["B"],
      },
    });

    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a2" },
        { id: "B", index: "a1" },
      ],
      expect: {
        unchangedElements: ["A"],
      },
    });
  });

  describe("should sync when fractional indices are out of order", () => {
    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a3" },
        { id: "B", index: "a2" },
        { id: "C", index: "a1" },
      ],
      movedElements: ["B", "C"],
      expect: {
        unchangedElements: ["A"],
      },
    });

    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a3" },
        { id: "B", index: "a2" },
        { id: "C", index: "a1" },
      ],
      expect: {
        unchangedElements: ["A"],
      },
    });
  });

  describe("should sync when incorrect fractional index is in between correct ones ", () => {
    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a1" },
        { id: "B", index: "a0" },
        { id: "C", index: "a2" },
      ],
      movedElements: ["B"],
      expect: {
        unchangedElements: ["A", "C"],
      },
    });

    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a1" },
        { id: "B", index: "a0" },
        { id: "C", index: "a2" },
      ],
      expect: {
        unchangedElements: ["A", "C"],
      },
    });
  });

  describe("should sync when incorrect fractional index is on top and duplicated below", () => {
    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a1" },
        { id: "B", index: "a2" },
        { id: "C", index: "a1" },
      ],
      movedElements: ["C"],
      expect: {
        unchangedElements: ["A", "B"],
      },
    });

    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a1" },
        { id: "B", index: "a2" },
        { id: "C", index: "a1" },
      ],
      expect: {
        unchangedElements: ["A", "B"],
      },
    });
  });

  describe("should sync when given a mix of duplicate / invalid indices", () => {
    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a0" },
        { id: "B", index: "a2" },
        { id: "C", index: "a1" },
        { id: "D", index: "a1" },
        { id: "E", index: "a2" },
      ],
      movedElements: ["B", "D", "E"],
      expect: {
        unchangedElements: ["A", "C"],
      },
    });

    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a0" },
        { id: "B", index: "a2" },
        { id: "C", index: "a1" },
        { id: "D", index: "a1" },
        { id: "E", index: "a2" },
      ],
      movedElements: ["C", "D", "E"],
      expect: {
        unchangedElements: ["A", "B"],
      },
    });

    testFractionalIndicesSync({
      elements: [
        { id: "A", index: "a0" },
        { id: "B", index: "a2" },
        { id: "C", index: "a1" },
        { id: "D", index: "a1" },
        { id: "E", index: "a2" },
      ],
      expect: {
        unchangedElements: ["A", "B"],
      },
    });
  });

  describe("should sync when given a mix of undefined / invalid indices", () => {
    testFractionalIndicesSync({
      elements: [
        { id: "A" },
        { id: "B" },
        { id: "C", index: "a0" },
        { id: "D", index: "a2" },
        { id: "E" },
        { id: "F", index: "a3" },
        { id: "G" },
        { id: "H", index: "a1" },
        { id: "I", index: "a2" },
        { id: "J" },
      ],
      movedElements: ["A", "B", "D", "E", "F", "G", "J"],
      expect: {
        unchangedElements: ["C", "H", "I"],
      },
    });

    testFractionalIndicesSync({
      elements: [
        { id: "A" },
        { id: "B" },
        { id: "C", index: "a0" },
        { id: "D", index: "a2" },
        { id: "E" },
        { id: "F", index: "a3" },
        { id: "G" },
        { id: "H", index: "a1" },
        { id: "I", index: "a2" },
        { id: "J" },
      ],
      movedElements: ["A", "B", "E", "G", "H", "I", "J"],
      expect: {
        unchangedElements: ["C", "D", "F"],
      },
    });

    testFractionalIndicesSync({
      elements: [
        { id: "A" },
        { id: "B" },
        { id: "C", index: "a0" },
        { id: "D", index: "a2" },
        { id: "E" },
        { id: "F", index: "a3" },
        { id: "G" },
        { id: "H", index: "a1" },
        { id: "I", index: "a2" },
        { id: "J" },
      ],
      expect: {
        unchangedElements: ["C", "D", "F"],
      },
    });
  });

  describe("should generate fractions for explicitly moved elements", () => {
    describe("should generate a fraction between 'A' and 'C'", () => {
      testFractionalIndicesSync({
        elements: [
          { id: "A", index: "a1" },
          // doing actual fractions, without jitter 'a1' becomes 'a1V'
          // as V is taken as the charset's middle-right value
          { id: "B", index: "a1" },
          { id: "C", index: "a2" },
        ],
        movedElements: ["B"],
        expect: {
          unchangedElements: ["A", "C"],
        },
      });

      testFractionalIndicesSync({
        elements: [
          { id: "A", index: "a1" },
          { id: "B", index: "a1" },
          { id: "C", index: "a2" },
        ],
        expect: {
          // as above, B will become fractional
          unchangedElements: ["A", "C"],
        },
      });
    });

    describe("should generate fractions given duplicated indices", () => {
      testFractionalIndicesSync({
        elements: [
          { id: "A", index: "a01" },
          { id: "B", index: "a01" },
          { id: "C", index: "a01" },
          { id: "D", index: "a01" },
          { id: "E", index: "a02" },
          { id: "F", index: "a02" },
          { id: "G", index: "a02" },
        ],
        movedElements: ["B", "C", "D", "E", "F"],
        expect: {
          unchangedElements: ["A", "G"],
        },
      });

      testFractionalIndicesSync({
        elements: [
          { id: "A", index: "a01" },
          { id: "B", index: "a01" },
          { id: "C", index: "a01" },
          { id: "D", index: "a01" },
          { id: "E", index: "a02" },
          { id: "F", index: "a02" },
          { id: "G", index: "a02" },
        ],
        movedElements: ["A", "C", "D", "E", "G"],
        expect: {
          unchangedElements: ["B", "F"],
        },
      });

      testFractionalIndicesSync({
        elements: [
          { id: "A", index: "a01" },
          { id: "B", index: "a01" },
          { id: "C", index: "a01" },
          { id: "D", index: "a01" },
          { id: "E", index: "a02" },
          { id: "F", index: "a02" },
          { id: "G", index: "a02" },
        ],
        movedElements: ["B", "C", "D", "F", "G"],
        expect: {
          unchangedElements: ["A", "E"],
        },
      });

      testFractionalIndicesSync({
        elements: [
          { id: "A", index: "a01" },
          { id: "B", index: "a01" },
          { id: "C", index: "a01" },
          { id: "D", index: "a01" },
          { id: "E", index: "a02" },
          { id: "F", index: "a02" },
          { id: "G", index: "a02" },
        ],
        expect: {
          // notice fallback considers first item (E) as a valid one
          unchangedElements: ["A", "E"],
        },
      });
    });
  });

  describe("should be able to sync 20K invalid indices", () => {
    const length = 20_000;

    describe("should sync all empty indices", () => {
      const elements = Array.from({ length }).map((_, index) => ({
        id: `A_${index}`,
      }));

      testFractionalIndicesSync({
        // elements without fractional index
        elements,
        movedElements: Array.from({ length }).map((_, index) => `A_${index}`),
        expect: {
          unchangedElements: [],
        },
      });

      testFractionalIndicesSync({
        // elements without fractional index
        elements,
        expect: {
          unchangedElements: [],
        },
      });
    });

    describe("should sync all but last index given a growing array of indices", () => {
      let lastIndex: string | null = null;

      const elements = Array.from({ length }).map((_, index) => {
        // going up from 'a0'
        lastIndex = generateKeyBetween(lastIndex, null);

        return {
          id: `A_${index}`,
          // assigning only the last generated index, so sync can go down from there
          // without jitter lastIndex is 'c4BZ' for 20000th element
          index: index === length - 1 ? lastIndex : undefined,
        };
      });
      const movedElements = Array.from({ length }).map(
        (_, index) => `A_${index}`,
      );
      // remove last element
      movedElements.pop();

      testFractionalIndicesSync({
        elements,
        movedElements,
        expect: {
          unchangedElements: [`A_${length - 1}`],
        },
      });

      testFractionalIndicesSync({
        elements,
        expect: {
          unchangedElements: [`A_${length - 1}`],
        },
      });
    });

    describe("should sync all but first index given a declining array of indices", () => {
      let lastIndex: string | null = null;

      const elements = Array.from({ length }).map((_, index) => {
        // going down from 'a0'
        lastIndex = generateKeyBetween(null, lastIndex);

        return {
          id: `A_${index}`,
          // without jitter lastIndex is 'XvoR' for 20000th element
          index: lastIndex,
        };
      });
      const movedElements = Array.from({ length }).map(
        (_, index) => `A_${index}`,
      );
      // remove first element
      movedElements.shift();

      testFractionalIndicesSync({
        elements,
        movedElements,
        expect: {
          unchangedElements: [`A_0`],
        },
      });

      testFractionalIndicesSync({
        elements,
        expect: {
          unchangedElements: [`A_0`],
        },
      });
    });
  });

  describe("should automatically fallback to fixing all invalid indices", () => {
    describe("should fallback to syncing duplicated indices when moved elements are empty", () => {
      testFractionalIndicesSync({
        elements: [
          { id: "A", index: "a1" },
          { id: "B", index: "a1" },
          { id: "C", index: "a1" },
        ],
        // the validation will throw as nothing was synced
        // therefore it will lead to triggering the fallback and fixing all invalid indices
        movedElements: [],
        expect: {
          unchangedElements: ["A"],
        },
      });
    });

    describe("should fallback to syncing undefined / invalid indices when moved elements are empty", () => {
      testFractionalIndicesSync({
        elements: [
          { id: "A", index: "a1" },
          { id: "B" },
          { id: "C", index: "a0" },
        ],
        // since elements are invalid, this will fail the validation
        // leading to fallback fixing "B" and "C"
        movedElements: [],
        expect: {
          unchangedElements: ["A"],
        },
      });
    });

    describe("should fallback to syncing unordered indices when moved element is invalid", () => {
      testFractionalIndicesSync({
        elements: [
          { id: "A", index: "a1" },
          { id: "B", index: "a2" },
          { id: "C", index: "a1" },
        ],
        movedElements: ["A"],
        expect: {
          unchangedElements: ["A", "B"],
        },
      });
    });

    describe("should fallback when trying to generate an index in between unordered elements", () => {
      testFractionalIndicesSync({
        elements: [
          { id: "A", index: "a2" },
          { id: "B" },
          { id: "C", index: "a1" },
        ],
        // 'B' is invalid, but so is 'C', which was not marked as moved
        // therefore it will try to generate a key between 'a2' and 'a1'
        // which it cannot do, thus will throw during generation and automatically fallback
        movedElements: ["B"],
        expect: {
          unchangedElements: ["A"],
        },
      });
    });

    describe("should fallback when trying to generate an index in between duplicate indices", () => {
      testFractionalIndicesSync({
        elements: [
          { id: "A", index: "a01" },
          { id: "B" },
          { id: "C" },
          { id: "D", index: "a01" },
          { id: "E", index: "a01" },
          { id: "F", index: "a01" },
          { id: "G" },
          { id: "I", index: "a03" },
          { id: "H" },
        ],
        // missed "E" therefore upper bound for 'B' is a01, while lower bound is 'a02'
        // therefore, similarly to above, it will fail during key generation and lead to fallback
        movedElements: ["B", "C", "D", "F", "G", "H"],
        expect: {
          unchangedElements: ["A", "I"],
        },
      });
    });
  });
});

function testFractionalIndicesSync(args: {
  elements: { id: string; index?: string }[];
  movedElements?: string[];
  expect: {
    unchangedElements: string[];
    validInput?: true;
  };
}) {
  const [elements, movedElements] = prepareArguments(
    args.elements,
    args.movedElements,
  );
  const expectUnchangedElements = arrayToMap(
    args.expect.unchangedElements.map((x) => ({ id: x })),
  );

  const name = movedElements
    ? "should sync invalid indices of moved elements or fallback"
    : "should sync invalid indices of all elements";

  test(
    name,
    elements,
    movedElements,
    expectUnchangedElements,
    args.expect.validInput,
  );
}

function prepareArguments(
  elementsLike: { id: string; index?: string }[],
  movedElementsIds?: string[],
): [ExcalidrawElement[], Map<string, ExcalidrawElement> | undefined] {
  const elements = elementsLike.map((x) =>
    API.createElement({ id: x.id, index: x.index as FractionalIndex }),
  );
  const movedMap = arrayToMap(movedElementsIds || []);
  const movedElements = movedElementsIds
    ? arrayToMap(elements.filter((x) => movedMap.has(x.id)))
    : undefined;

  return [elements, movedElements];
}

function test(
  name: string,
  elements: ExcalidrawElement[],
  movedElements: Map<string, ExcalidrawElement> | undefined,
  expectUnchangedElements: Map<string, { id: string }>,
  expectValidInput?: boolean,
) {
  it(name, () => {
    // ensure the input is invalid (unless the flag is on)
    if (!expectValidInput) {
      expect(() =>
        validateFractionalIndices(elements.map((x) => x.index)),
      ).toThrowError(InvalidFractionalIndexError);
    }

    // clone due to mutation
    const clonedElements = elements.map((x) => deepCopyElement(x));

    // Act
    const syncedElements = syncFractionalIndices(clonedElements, movedElements);

    expect(syncedElements.length).toBe(elements.length);
    expect(() =>
      validateFractionalIndices(syncedElements.map((x) => x.index)),
    ).not.toThrowError(InvalidFractionalIndexError);

    syncedElements.forEach((synced, index) => {
      const element = elements[index];
      // ensure the order hasn't changed
      expect(synced.id).toBe(element.id);

      if (expectUnchangedElements.has(synced.id)) {
        // ensure we didn't mutate where we didn't want to mutate
        expect(synced.index).toBe(elements[index].index);
        expect(synced.version).toBe(elements[index].version);
      } else {
        expect(synced.index).not.toBe(elements[index].index);
        // ensure we mutated just once, even with fallback triggered
        expect(synced.version).toBe(elements[index].version + 1);
      }
    });
  });
}