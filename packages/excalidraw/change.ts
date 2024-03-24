import { ENV } from "./constants";
import {
  AffectedBindableElements,
  AffectedBoundElements,
} from "./element/binding";
import { LinearElementEditor } from "./element/linearElementEditor";
import {
  ElementUpdate,
  mutateElement,
  newElementWith,
} from "./element/mutateElement";
import {
  getBoundTextElementId,
  redrawTextBoundingBox,
} from "./element/textElement";
import { hasBoundTextElement, isBoundToContainer } from "./element/typeChecks";
import {
  ExcalidrawLinearElement,
  ExcalidrawTextElement,
  NonDeleted,
  OrderedExcalidrawElement,
  SceneElementsMap,
} from "./element/types";
import { orderByFractionalIndex, syncMovedIndices } from "./fractionalIndex";
import { getObservedAppState } from "./store";
import {
  AppState,
  ObservedAppState,
  ObservedElementsAppState,
  ObservedStandaloneAppState,
} from "./types";
import { Mutable, SubtypeOf } from "./utility-types";
import {
  arrayToMap,
  arrayToObject,
  assertNever,
  isShallowEqual,
  toBrandedType,
} from "./utils";

/**
 * Represents the difference between two objects of the same type.
 *
 * Both `deleted` and `inserted` partials represent the same set of added, removed or updated properties, where:
 * - `deleted` is a set of all the previous (removed) values
 * - `inserted` is a set of all the next (added, updated) values
 *
 * In addition, we have two forms of representing reference values:
 * - by default, `deleted` & `inserted` contains all the properties, even if only one property has changed
 *  - i.e. check text element `points` prop,  when applied, it will override all the existing points
 * - to granularly resolve conflicts on the level of individual properties, `postProcess` could be used to extract only changed properties
 *  - i.e. check element's `groupIds` prop, when applied, it will be merged with existing `groupIds
 * - related reasoning https://github.com/excalidraw/excalidraw/pull/7348#discussion_r1521718445
 *
 * Keeping it as pure object (without transient state, side-effects, etc.), so we won't have to instantiate it on load.
 */
class Delta<T> {
  private constructor(
    public readonly deleted: Partial<T>,
    public readonly inserted: Partial<T>,
  ) {}

  public static create<T>(
    deleted: Partial<T>,
    inserted: Partial<T>,
    modifier?: (delta: Partial<T>) => Partial<T>,
    modifierOptions?: "deleted" | "inserted",
  ) {
    const modifiedDeleted =
      modifier && modifierOptions !== "inserted" ? modifier(deleted) : deleted;
    const modifiedInserted =
      modifier && modifierOptions !== "deleted" ? modifier(inserted) : inserted;

    return new Delta(modifiedDeleted, modifiedInserted);
  }

  /**
   * Calculates the delta between two objects.
   *
   * @param prevObject - The previous state of the object.
   * @param nextObject - The next state of the object.
   *
   * @returns new delta instance.
   */
  public static calculate<T extends { [key: string]: any }>(
    prevObject: T,
    nextObject: T,
    modifier?: (partial: Partial<T>) => Partial<T>,
    postProcess?: (
      deleted: Partial<T>,
      inserted: Partial<T>,
    ) => [Partial<T>, Partial<T>],
  ): Delta<T> {
    if (prevObject === nextObject) {
      return Delta.empty();
    }

    const deleted = {} as Partial<T>;
    const inserted = {} as Partial<T>;

    // O(n^3) here, but it's not as bad as it looks:
    // - we do this only on store recordings, not on every frame (not for ephemerals)
    // - we do this only on previously detected changed elements
    // - we do shallow compare only on the first level of properties (not going any deeper)
    // - # of element's properties is reasonably small
    for (const key of this.distinctKeysIterator(
      "full",
      prevObject,
      nextObject,
    )) {
      deleted[key as keyof T] = prevObject[key];
      inserted[key as keyof T] = nextObject[key];
    }

    const [processedDeleted, processedInserted] = postProcess
      ? postProcess(deleted, inserted)
      : [deleted, inserted];

    return Delta.create(processedDeleted, processedInserted, modifier);
  }

  public static empty() {
    return new Delta({}, {});
  }

  public static isEmpty<T>(delta: Delta<T>): boolean {
    return (
      !Object.keys(delta.deleted).length && !Object.keys(delta.inserted).length
    );
  }

  /**
   * Merges object partials.
   */
  public static merge<T extends { [key: string]: unknown }>(
    prev: T,
    added: T,
    removed: T,
  ) {
    const cloned = { ...prev };

    for (const key of Object.keys(removed)) {
      delete cloned[key];
    }

    return { ...cloned, ...added };
  }

  /**
   * Compares if object1 contains any different value compared to the object2.
   */
  public static isLeftDifferent<T extends {}>(
    object1: T,
    object2: T,
    skipShallowCompare = false,
  ): boolean {
    const anyDistinctKey = this.distinctKeysIterator(
      "left",
      object1,
      object2,
      skipShallowCompare,
    ).next().value;

    return !!anyDistinctKey;
  }

  /**
   * Compares if object2 contains any different value compared to the object1.
   */
  public static isRightDifferent<T extends {}>(
    object1: T,
    object2: T,
    skipShallowCompare = false,
  ): boolean {
    const anyDistinctKey = this.distinctKeysIterator(
      "right",
      object1,
      object2,
      skipShallowCompare,
    ).next().value;

    return !!anyDistinctKey;
  }

  /**
   * Returns all the object1 keys that have distinct values.
   */
  public static getLeftDifferences<T extends {}>(
    object1: T,
    object2: T,
    skipShallowCompare = false,
  ) {
    return Array.from(
      this.distinctKeysIterator("left", object1, object2, skipShallowCompare),
    );
  }

  /**
   * Returns all the object2 keys that have distinct values.
   */
  public static getRightDifferences<T extends {}>(
    object1: T,
    object2: T,
    skipShallowCompare = false,
  ) {
    return Array.from(
      this.distinctKeysIterator("right", object1, object2, skipShallowCompare),
    );
  }

  /**
   * Iterator comparing values of object properties based on the passed joining strategy.
   *
   * @yields keys of properties with different values
   *
   * WARN: it's based on shallow compare performed only on the first level and doesn't go deeper than that.
   */
  private static *distinctKeysIterator<T extends {}>(
    join: "left" | "right" | "full",
    object1: T,
    object2: T,
    skipShallowCompare = false,
  ) {
    if (object1 === object2) {
      return;
    }

    let keys: string[] = [];

    if (join === "left") {
      keys = Object.keys(object1);
    } else if (join === "right") {
      keys = Object.keys(object2);
    } else {
      keys = Array.from(
        new Set([...Object.keys(object1), ...Object.keys(object2)]),
      );
    }

    for (const key of keys) {
      const object1Value = object1[key as keyof T];
      const object2Value = object2[key as keyof T];

      if (object1Value !== object2Value) {
        if (
          !skipShallowCompare &&
          typeof object1Value === "object" &&
          typeof object2Value === "object" &&
          object1Value !== null &&
          object2Value !== null &&
          isShallowEqual(object1Value, object2Value)
        ) {
          continue;
        }

        yield key;
      }
    }
  }
}

/**
 * Encapsulates the modifications captured as `Delta`/s.
 */
interface Change<T> {
  /**
   * Inverses the `Delta`s inside while creating a new `Change`.
   */
  inverse(): Change<T>;

  /**
   * Applies the `Change` to the previous object.
   *
   * @returns a tuple of the next object `T` with applied change, and `boolean`, indicating whether the applied change resulted in a visible change.
   */
  applyTo(previous: T, ...options: unknown[]): [T, boolean];

  /**
   * Checks whether there are actually `Delta`s.
   */
  isEmpty(): boolean;
}

export class AppStateChange implements Change<AppState> {
  private constructor(private readonly delta: Delta<ObservedAppState>) {}

  public static calculate<T extends ObservedAppState>(
    prevAppState: T,
    nextAppState: T,
  ): AppStateChange {
    const delta = Delta.calculate(
      prevAppState,
      nextAppState,
      undefined,
      AppStateChange.postProcess,
    );

    return new AppStateChange(delta);
  }

  public static empty() {
    return new AppStateChange(Delta.create({}, {}));
  }

  public inverse(): AppStateChange {
    const inversedDelta = Delta.create(this.delta.inserted, this.delta.deleted);
    return new AppStateChange(inversedDelta);
  }

  public applyTo(
    appState: AppState,
    elements: SceneElementsMap,
  ): [AppState, boolean] {
    const {
      selectedElementIds: removedSelectedElementIds = {},
      selectedGroupIds: removedSelectedGroupIds = {},
    } = this.delta.deleted;

    const {
      selectedElementIds: addedSelectedElementIds = {},
      selectedGroupIds: addedSelectedGroupIds = {},
      selectedLinearElementId,
      editingLinearElementId,
      ...directlyApplicablePartial
    } = this.delta.inserted;

    const mergedSelectedElementIds = Delta.merge(
      appState.selectedElementIds,
      addedSelectedElementIds,
      removedSelectedElementIds,
    );

    const mergedSelectedGroupIds = Delta.merge(
      appState.selectedGroupIds,
      addedSelectedGroupIds,
      removedSelectedGroupIds,
    );

    const selectedLinearElement =
      selectedLinearElementId && elements.has(selectedLinearElementId)
        ? new LinearElementEditor(
            elements.get(
              selectedLinearElementId,
            ) as NonDeleted<ExcalidrawLinearElement>,
          )
        : null;

    const editingLinearElement =
      editingLinearElementId && elements.has(editingLinearElementId)
        ? new LinearElementEditor(
            elements.get(
              editingLinearElementId,
            ) as NonDeleted<ExcalidrawLinearElement>,
          )
        : null;

    const nextAppState = {
      ...appState,
      ...directlyApplicablePartial,
      selectedElementIds: mergedSelectedElementIds,
      selectedGroupIds: mergedSelectedGroupIds,
      selectedLinearElement:
        typeof selectedLinearElementId !== "undefined"
          ? selectedLinearElement // element was either inserted or deleted
          : appState.selectedLinearElement, // otherwise assign what we had before
      editingLinearElement:
        typeof editingLinearElementId !== "undefined"
          ? editingLinearElement // element was either inserted or deleted
          : appState.editingLinearElement, // otherwise assign what we had before
    };

    const constainsVisibleChanges = this.filterInvisibleChanges(
      appState,
      nextAppState,
      elements,
    );

    return [nextAppState, constainsVisibleChanges];
  }

  public isEmpty(): boolean {
    return Delta.isEmpty(this.delta);
  }

  /**
   * It is necessary to post process the partials in case of reference values,
   * for which we need to calculate the real diff between `deleted` and `inserted`.
   */
  private static postProcess<T extends ObservedAppState>(
    deleted: Partial<T>,
    inserted: Partial<T>,
  ): [Partial<T>, Partial<T>] {
    if (deleted.selectedElementIds && inserted.selectedElementIds) {
      const deletedDifferences = Delta.getLeftDifferences(
        deleted.selectedElementIds,
        inserted.selectedElementIds,
      ).reduce((acc, id) => {
        acc[id] = true;
        return acc;
      }, {} as Mutable<ObservedAppState["selectedElementIds"]>);

      const insertedDifferences = Delta.getRightDifferences(
        deleted.selectedElementIds,
        inserted.selectedElementIds,
      ).reduce((acc, id) => {
        acc[id] = true;
        return acc;
      }, {} as Mutable<ObservedAppState["selectedElementIds"]>);

      (deleted as Mutable<Partial<T>>).selectedElementIds = deletedDifferences;
      (inserted as Mutable<Partial<T>>).selectedElementIds =
        insertedDifferences;
    }

    if (deleted.selectedGroupIds && inserted.selectedGroupIds) {
      const deletedDifferences = Delta.getLeftDifferences(
        deleted.selectedGroupIds,
        inserted.selectedGroupIds,
      ).reduce((acc, groupId) => {
        acc[groupId] = deleted.selectedGroupIds![groupId];
        return acc;
      }, {} as Mutable<ObservedAppState["selectedGroupIds"]>);

      const insertedDifferences = Delta.getRightDifferences(
        deleted.selectedGroupIds,
        inserted.selectedGroupIds,
      ).reduce((acc, groupId) => {
        acc[groupId] = inserted.selectedGroupIds![groupId];
        return acc;
      }, {} as Mutable<ObservedAppState["selectedGroupIds"]>);

      (deleted as Mutable<Partial<T>>).selectedGroupIds = deletedDifferences;
      (inserted as Mutable<Partial<T>>).selectedGroupIds = insertedDifferences;
    }

    return [deleted, inserted];
  }

  /**
   * Mutates `nextAppState` be filtering out state related to deleted elements.
   *
   * @returns `true` if a visible change is found, `false` otherwise.
   */
  private filterInvisibleChanges(
    prevAppState: AppState,
    nextAppState: AppState,
    nextElements: SceneElementsMap,
  ): boolean {
    const prevObservedAppState = getObservedAppState(prevAppState);
    const nextObservedAppState = getObservedAppState(nextAppState);

    const visibleDifferenceFlag = { value: false };
    const containsStandaloneDifference = Delta.isRightDifferent(
      AppStateChange.stripElementsProps(prevObservedAppState),
      AppStateChange.stripElementsProps(nextObservedAppState),
    );

    if (containsStandaloneDifference) {
      // we detected a a difference which is unrelated to the elements
      visibleDifferenceFlag.value = true;
    }

    const containsElementsDifference = Delta.isRightDifferent(
      AppStateChange.stripStandaloneProps(prevObservedAppState),
      AppStateChange.stripStandaloneProps(nextObservedAppState),
    );

    if (!containsStandaloneDifference && !containsElementsDifference) {
      // there is no difference detected at all
      visibleDifferenceFlag.value = false;
    }

    // we need to handle elements differences separately,
    // as they could be related to deleted elements and/or they could on their own result in no visible action
    const changedDeltaKeys = Delta.getRightDifferences(
      AppStateChange.stripStandaloneProps(prevObservedAppState),
      AppStateChange.stripStandaloneProps(nextObservedAppState),
    ) as Array<keyof ObservedElementsAppState>;

    // check whether delta properties are related to the existing non-deleted elements
    for (const key of changedDeltaKeys) {
      switch (key) {
        case "selectedElementIds":
          nextAppState.selectedElementIds =
            AppStateChange.filterSelectedElements(
              nextAppState[key],
              nextElements,
              visibleDifferenceFlag,
            );
          break;
        case "selectedLinearElementId":
        case "editingLinearElementId":
          // map the increment key back into the appState key
          const appStateKey =
            key === "selectedLinearElementId"
              ? "selectedLinearElement"
              : "editingLinearElement";

          nextAppState[appStateKey] = AppStateChange.filterLinearElement(
            nextAppState[appStateKey],
            nextElements,
            visibleDifferenceFlag,
          );
          break;
        case "editingGroupId":
        case "selectedGroupIds":
          // TODO: Currently we don't have an index of elements by groupIds, which means that
          // the calculation for getting the visible elements based on the groupIds stored in delta
          // is not worth performing - due to perf. and dev. complexity.
          //
          // Therefore we are accepting in these cases empty undos / redos, which should be pretty rare:
          // - only when one of these (or both) are in delta and there are no non deleted elements containing these group ids
          visibleDifferenceFlag.value = true;
          break;
        default: {
          assertNever(
            key,
            `Unknown ObservedElementsAppState key "${key}"`,
            true,
          );
        }
      }
    }

    return visibleDifferenceFlag.value;
  }

  private static filterSelectedElements(
    selectedElementIds: AppState["selectedElementIds"],
    elements: SceneElementsMap,
    visibleDifferenceFlag: { value: boolean },
  ) {
    const nextSelectedElementIds = { ...selectedElementIds };

    for (const id of Object.keys(selectedElementIds)) {
      const element = elements.get(id);

      if (element && !element.isDeleted) {
        // found related visible element!
        visibleDifferenceFlag.value = true;
      } else {
        delete nextSelectedElementIds[id];
      }
    }

    return nextSelectedElementIds;
  }

  private static filterLinearElement(
    linearElement:
      | AppState["editingLinearElement"]
      | AppState["selectedLinearElement"],
    elements: SceneElementsMap,
    visibleDifferenceFlag: { value: boolean },
  ) {
    if (!linearElement) {
      return null;
    }

    let result: typeof linearElement | null = linearElement;

    const element = elements.get(linearElement.elementId);

    if (element && !element.isDeleted) {
      // found related visible element!
      visibleDifferenceFlag.value = true;
    } else {
      result = null;
    }

    return result;
  }

  private static stripElementsProps(
    delta: Partial<ObservedAppState>,
  ): Partial<ObservedStandaloneAppState> {
    // WARN: Do not remove the type-casts as they here to ensure proper type checks
    const {
      editingGroupId,
      selectedGroupIds,
      selectedElementIds,
      editingLinearElementId,
      selectedLinearElementId,
      ...standaloneProps
    } = delta as ObservedAppState;

    return standaloneProps as SubtypeOf<
      typeof standaloneProps,
      ObservedStandaloneAppState
    >;
  }

  private static stripStandaloneProps(
    delta: Partial<ObservedAppState>,
  ): Partial<ObservedElementsAppState> {
    // WARN: Do not remove the type-casts as they here to ensure proper type checks
    const { name, viewBackgroundColor, ...elementsProps } =
      delta as ObservedAppState;

    return elementsProps as SubtypeOf<
      typeof elementsProps,
      ObservedElementsAppState
    >;
  }
}

type ElementPartial = Omit<ElementUpdate<OrderedExcalidrawElement>, "seed">;

/**
 * Elements change is a low level primitive to capture a change between two sets of elements.
 * It does so by encapsulating forward and backward `Delta`s, allowing to time-travel in both directions.
 */
export class ElementsChange implements Change<SceneElementsMap> {
  private constructor(
    private readonly added: Map<string, Delta<ElementPartial>>,
    private readonly removed: Map<string, Delta<ElementPartial>>,
    private readonly updated: Map<string, Delta<ElementPartial>>,
  ) {}

  public static create(
    added: Map<string, Delta<ElementPartial>>,
    removed: Map<string, Delta<ElementPartial>>,
    updated: Map<string, Delta<ElementPartial>>,
  ) {
    if (import.meta.env.DEV || import.meta.env.MODE === ENV.TEST) {
      ElementsChange.validateInvariants(
        "added",
        added,
        // clement could be inserted as deleted - ignoring "inserted"
        (deleted, _) => deleted.isDeleted === true,
      );
      ElementsChange.validateInvariants(
        "removed",
        removed,
        (deleted, inserted) =>
          deleted.isDeleted === false && inserted.isDeleted === true,
      );
      ElementsChange.validateInvariants(
        "updated",
        updated,
        (deleted, inserted) => !deleted.isDeleted && !inserted.isDeleted,
      );
    }

    return new ElementsChange(added, removed, updated);
  }

  private static validateInvariants(
    type: "added" | "removed" | "updated",
    deltas: Map<string, Delta<ElementPartial>>,
    satifiesInvariants: (
      deleted: ElementPartial,
      inserted: ElementPartial,
    ) => boolean,
  ) {
    for (const [id, delta] of deltas.entries()) {
      if (!satifiesInvariants(delta.deleted, delta.inserted)) {
        console.error(
          `Broken invariant for "${type}" delta, element "${id}", delta:`,
          delta,
        );
        throw new Error(`ElementsChange invariant broken for element "${id}".`);
      }
    }
  }

  /**
   * Calculates the `Delta`s between the previous and next set of elements.
   *
   * @param prevElements - Map representing the previous state of elements.
   * @param nextElements - Map representing the next state of elements.
   *
   * @returns `ElementsChange` instance representing the `Delta` changes between the two sets of elements.
   */
  public static calculate<T extends OrderedExcalidrawElement>(
    prevElements: Map<string, T>,
    nextElements: Map<string, T>,
  ): ElementsChange {
    if (prevElements === nextElements) {
      return ElementsChange.empty();
    }

    const added = new Map<string, Delta<ElementPartial>>();
    const removed = new Map<string, Delta<ElementPartial>>();
    const updated = new Map<string, Delta<ElementPartial>>();

    // this might be needed only in same edge cases, like during collab, when `isDeleted` elements get removed or when we (un)intentionally remove the elements
    for (const prevElement of prevElements.values()) {
      const nextElement = nextElements.get(prevElement.id);

      if (!nextElement) {
        const deleted = { ...prevElement, isDeleted: false } as ElementPartial;
        const inserted = { isDeleted: true } as ElementPartial;

        const delta = Delta.create(
          deleted,
          inserted,
          ElementsChange.stripIrrelevantProps,
        );

        removed.set(prevElement.id, delta);
      }
    }

    for (const nextElement of nextElements.values()) {
      const prevElement = prevElements.get(nextElement.id);

      if (!prevElement) {
        const deleted = { isDeleted: true } as ElementPartial;
        const inserted = {
          ...nextElement,
          isDeleted: false,
        } as ElementPartial;

        const delta = Delta.create(
          deleted,
          inserted,
          ElementsChange.stripIrrelevantProps,
        );

        added.set(nextElement.id, delta);

        continue;
      }

      if (prevElement.versionNonce !== nextElement.versionNonce) {
        const delta = Delta.calculate<ElementPartial>(
          prevElement,
          nextElement,
          ElementsChange.stripIrrelevantProps,
          ElementsChange.postProcess,
        );

        if (
          // making sure we don't get here some non-boolean values (i.e. undefined, null, etc.)
          typeof prevElement.isDeleted === "boolean" &&
          typeof nextElement.isDeleted === "boolean" &&
          prevElement.isDeleted !== nextElement.isDeleted
        ) {
          // notice that other props could have been updated as well
          if (prevElement.isDeleted && !nextElement.isDeleted) {
            added.set(nextElement.id, delta);
          } else {
            removed.set(nextElement.id, delta);
          }

          continue;
        }

        // making sure there are at least some changes
        if (!Delta.isEmpty(delta)) {
          updated.set(nextElement.id, delta);
        }
      }
    }

    return ElementsChange.create(added, removed, updated);
  }

  public static empty() {
    return ElementsChange.create(new Map(), new Map(), new Map());
  }

  public inverse(): ElementsChange {
    const inverseInternal = (deltas: Map<string, Delta<ElementPartial>>) => {
      const inversedDeltas = new Map<string, Delta<ElementPartial>>();

      for (const [id, delta] of deltas.entries()) {
        inversedDeltas.set(id, Delta.create(delta.inserted, delta.deleted));
      }

      return inversedDeltas;
    };

    const added = inverseInternal(this.added);
    const removed = inverseInternal(this.removed);
    const updated = inverseInternal(this.updated);

    // notice we inverse removed with added not to break the invariants
    return ElementsChange.create(removed, added, updated);
  }

  public isEmpty(): boolean {
    return (
      this.added.size === 0 &&
      this.removed.size === 0 &&
      this.updated.size === 0
    );
  }

  /**
   * Update delta/s based on the existing elements.
   *
   * @param elements current elements
   * @param modifierOptions defines which of the delta (`deleted` or `inserted`) will be updated
   * @returns new instance with modified delta/s
   */
  public applyLatestChanges(
    elements: SceneElementsMap,
    modifierOptions: "deleted" | "inserted",
  ): ElementsChange {
    const modifier =
      (element: OrderedExcalidrawElement) => (partial: ElementPartial) => {
        const latestPartial: { [key: string]: unknown } = {};

        for (const key of Object.keys(partial) as Array<keyof typeof partial>) {
          if (
            key === "boundElements" ||
            key === "groupIds" ||
            key === "customData" ||
            key === "isDeleted"
          ) {
            // it doesn't make sense to update the above props since:
            // - `boundElements` and `groupIds` are reference values which are represented as removed/added changes in the delta
            // - `customData` can be anything
            // - `isDeleted` would break the invariants
            latestPartial[key] = partial[key];
          } else {
            latestPartial[key] = element[key];
          }
        }

        return latestPartial;
      };

    const applyLatestChangesInternal = (
      deltas: Map<string, Delta<ElementPartial>>,
    ) => {
      const modifiedDeltas = new Map<string, Delta<ElementPartial>>();

      for (const [id, delta] of deltas.entries()) {
        const existingElement = elements.get(id);

        if (existingElement) {
          const modifiedDelta = Delta.create(
            delta.deleted,
            delta.inserted,
            modifier(existingElement),
            modifierOptions,
          );

          modifiedDeltas.set(id, modifiedDelta);
        } else {
          // keep whatever we had
          modifiedDeltas.set(id, delta);
        }
      }

      return modifiedDeltas;
    };

    const added = applyLatestChangesInternal(this.added);
    const removed = applyLatestChangesInternal(this.removed);
    const updated = applyLatestChangesInternal(this.updated);

    return ElementsChange.create(added, removed, updated);
  }

  public applyTo(
    elements: SceneElementsMap,
    snapshot: Map<string, OrderedExcalidrawElement>,
  ): [SceneElementsMap, boolean] {
    let nextElements = toBrandedType<SceneElementsMap>(new Map(elements));

    const flags = {
      containsVisibleDifference: false,
      containsZindexDifference: false,
    };

    const applyDeltas = ElementsChange.createApplier(
      nextElements,
      snapshot,
      flags,
    );

    const addedElements = applyDeltas(this.added);
    const updatedElements = applyDeltas(this.updated);
    const removedElements = applyDeltas(this.removed);

    const changedElements = ElementsChange.resolveAffectedBindings(
      nextElements,
      addedElements,
      updatedElements,
      removedElements,
    );

    ElementsChange.redrawTextBoundingBoxes(nextElements, changedElements);
    nextElements = ElementsChange.reorderElements(
      nextElements,
      changedElements,
      flags,
    );

    return [nextElements, flags.containsVisibleDifference];
  }

  private static createApplier = (
    nextElements: SceneElementsMap,
    snapshot: Map<string, OrderedExcalidrawElement>,
    flags: {
      containsVisibleDifference: boolean;
      containsZindexDifference: boolean;
    },
  ) => {
    const getElement = ElementsChange.createGetter(
      nextElements,
      snapshot,
      flags,
    );

    return (deltas: Map<string, Delta<ElementPartial>>) =>
      Array.from(deltas.entries()).reduce((acc, [id, delta]) => {
        const element = getElement(id, delta.inserted);

        if (element) {
          const newElement = ElementsChange.applyDelta(element, delta, flags);
          nextElements.set(newElement.id, newElement);
          acc.set(newElement.id, newElement);
        }

        return acc;
      }, new Map<string, OrderedExcalidrawElement>());
  };

  private static createGetter =
    (
      elements: SceneElementsMap,
      snapshot: Map<string, OrderedExcalidrawElement>,
      flags: {
        containsVisibleDifference: boolean;
        containsZindexDifference: boolean;
      },
    ) =>
    (id: string, partial: ElementPartial) => {
      let element = elements.get(id);

      if (!element) {
        // always fallback to the local snapshot, in cases when we cannot find the element in the elements array
        element = snapshot.get(id);

        if (element) {
          // as the element was brought from the snapshot, it automatically results in a possible* zindex difference
          // *possible as there is additional check down the road at `reorderElements`
          flags.containsZindexDifference = true;

          // as the element was force deleted, we need to check if adding it back results in a visible change
          if (
            partial.isDeleted === false ||
            (partial.isDeleted !== true && element.isDeleted === false)
          ) {
            flags.containsVisibleDifference = true;
          }
        }
      }

      return element;
    };

  private static applyDelta(
    element: OrderedExcalidrawElement,
    delta: Delta<ElementPartial>,
    flags: {
      containsVisibleDifference: boolean;
      containsZindexDifference: boolean;
    },
  ) {
    const { boundElements: removedBoundElements, groupIds: removedGroupIds } =
      delta.deleted;

    const {
      boundElements: addedBoundElements,
      groupIds: addedGroupIds,
      ...directlyApplicablePartial
    } = delta.inserted;

    const { boundElements, groupIds } = element;

    let nextBoundElements = boundElements;
    if (addedBoundElements?.length || removedBoundElements?.length) {
      const mergedBoundElements = Object.values(
        Delta.merge(
          arrayToObject(nextBoundElements ?? [], (x) => x.id),
          arrayToObject(addedBoundElements ?? [], (x) => x.id),
          arrayToObject(removedBoundElements ?? [], (x) => x.id),
        ),
      );

      nextBoundElements = mergedBoundElements;
    }

    let nextGroupIds = groupIds;
    if (addedGroupIds?.length || removedGroupIds?.length) {
      const mergedGroupIds = Object.values(
        Delta.merge(
          arrayToObject(groupIds ?? []),
          arrayToObject(addedGroupIds ?? []),
          arrayToObject(removedGroupIds ?? []),
        ),
      );
      nextGroupIds = mergedGroupIds;
    }

    const mergedPartial: ElementPartial = {
      ...directlyApplicablePartial,
      boundElements: nextBoundElements,
      groupIds: nextGroupIds,
    };

    if (!flags.containsVisibleDifference) {
      // strip away fractional as even if it would be different, it doesn't have to result in visible change
      const { index, ...rest } = mergedPartial;
      const containsVisibleDifference =
        ElementsChange.checkForVisibleDifference(element, rest);

      flags.containsVisibleDifference = containsVisibleDifference;
    }

    if (!flags.containsZindexDifference) {
      flags.containsZindexDifference =
        delta.deleted.index !== delta.inserted.index;
    }

    const nextElement = newElementWith(element, mergedPartial);

    return nextElement;
  }

  /**
   * Check for visible changes regardless of whether they were removed, added or updated.
   */
  private static checkForVisibleDifference(
    element: OrderedExcalidrawElement,
    partial: ElementPartial,
  ) {
    if (element.isDeleted && partial.isDeleted !== false) {
      // when it's deleted and partial is not false, it cannot end up with a visible change
      return false;
    }

    if (element.isDeleted && partial.isDeleted === false) {
      // when we add an element, it results in a visible change
      return true;
    }

    if (element.isDeleted === false && partial.isDeleted) {
      // when we remove an element, it results in a visible change
      return true;
    }

    // check for any difference on a visible element
    return Delta.isRightDifferent(element, partial);
  }

  private static resolveAffectedBindings(
    nextElements: SceneElementsMap,
    added: Map<string, OrderedExcalidrawElement>,
    updated: Map<string, OrderedExcalidrawElement>,
    removed: Map<string, OrderedExcalidrawElement>,
  ) {
    const affected = new Map<string, OrderedExcalidrawElement>();
    const changed = new Map([...added, ...updated, ...removed]);

    const setter = (
      maybeAffectedElement: OrderedExcalidrawElement,
      updates: ElementUpdate<OrderedExcalidrawElement>,
    ) => {
      if (!changed.has(maybeAffectedElement.id)) {
        const affectedElement = newElementWith(maybeAffectedElement, updates);

        affected.set(affectedElement.id, affectedElement);
        nextElements.set(affectedElement.id, affectedElement);
      } else {
        // making sure we don't create a new instance of already changed element
        mutateElement(maybeAffectedElement, updates, false);
      }
    };

    ElementsChange.unbindAffectedElements(nextElements, removed, setter);
    ElementsChange.rebindAffectedElements(nextElements, updated, setter);
    ElementsChange.rebindAffectedElements(nextElements, added, setter);

    return new Map([...changed, ...affected]);
  }

  /**
   * Non deleted affected elements of removed elements,
   * should not contain bindings into the removed element/s - make sure to unbind such bindings.
   */
  private static unbindAffectedElements(
    elements: SceneElementsMap,
    removed: Map<string, OrderedExcalidrawElement>,
    setter: (
      element: OrderedExcalidrawElement,
      updates: ElementUpdate<OrderedExcalidrawElement>,
    ) => void,
  ) {
    for (const element of removed.values()) {
      AffectedBindableElements.unbind(elements, element, setter);
      AffectedBoundElements.unbind(elements, element, setter);
    }
  }

  /**
   * Non deleted affected elements of added or updated element/s,
   * should be rebound (if possible) with the current element - make sure bindings
   * from such elements into the current element are present & bi-directional.
   */
  private static rebindAffectedElements(
    elements: SceneElementsMap,
    maybeNonDeleted: Map<string, OrderedExcalidrawElement>,
    setter: (
      element: OrderedExcalidrawElement,
      updates: ElementUpdate<OrderedExcalidrawElement>,
    ) => void,
  ) {
    for (const element of maybeNonDeleted.values()) {
      AffectedBindableElements.rebind(elements, element, setter);
      AffectedBoundElements.rebind(elements, element, setter);
    }
  }

  private static redrawTextBoundingBoxes(
    elements: SceneElementsMap,
    changed: Map<string, OrderedExcalidrawElement>,
  ) {
    const boxesToRedraw = new Map<
      string,
      { container: OrderedExcalidrawElement; boundText: ExcalidrawTextElement }
    >();

    for (const element of changed.values()) {
      if (isBoundToContainer(element)) {
        const { containerId } = element as ExcalidrawTextElement;
        const container = containerId ? elements.get(containerId) : undefined;

        if (container) {
          boxesToRedraw.set(container.id, {
            container,
            boundText: element as ExcalidrawTextElement,
          });
        }
      }

      if (hasBoundTextElement(element)) {
        const boundTextElementId = getBoundTextElementId(element);
        const boundText = boundTextElementId
          ? elements.get(boundTextElementId)
          : undefined;

        if (boundText) {
          boxesToRedraw.set(element.id, {
            container: element,
            boundText: boundText as ExcalidrawTextElement,
          });
        }
      }
    }

    for (const { container, boundText } of boxesToRedraw.values()) {
      if (container.isDeleted || boundText.isDeleted) {
        // skip redraw if one of them is deleted, as it would not result in a meaningful redraw
        continue;
      }

      redrawTextBoundingBox(boundText, container, elements, false);
    }
  }

  private static reorderElements(
    elements: SceneElementsMap,
    changed: Map<string, OrderedExcalidrawElement>,
    flags: {
      containsVisibleDifference: boolean;
      containsZindexDifference: boolean;
    },
  ) {
    if (!flags.containsZindexDifference) {
      return elements;
    }

    const previous = Array.from(elements.values());
    const reordered = orderByFractionalIndex([...previous]);

    if (
      !flags.containsVisibleDifference &&
      Delta.isRightDifferent(previous, reordered, true)
    ) {
      // we found a difference in order!
      flags.containsVisibleDifference = true;
    }

    // let's synchronize all invalid indices of moved elements
    return arrayToMap(syncMovedIndices(reordered, changed)) as typeof elements;
  }

  /**
   * It is necessary to post process the partials in case of reference values,
   * for which we need to calculate the real diff between `deleted` and `inserted`.
   */
  private static postProcess(
    deleted: ElementPartial,
    inserted: ElementPartial,
  ): [ElementPartial, ElementPartial] {
    if (deleted.boundElements && inserted.boundElements) {
      const deletedDifferences = arrayToObject(
        Delta.getLeftDifferences(
          arrayToObject(deleted.boundElements, (x) => x.id),
          arrayToObject(inserted.boundElements, (x) => x.id),
        ),
      );
      const insertedDifferences = arrayToObject(
        Delta.getRightDifferences(
          arrayToObject(deleted.boundElements, (x) => x.id),
          arrayToObject(inserted.boundElements, (x) => x.id),
        ),
      );

      const insertedBoundElements = deleted.boundElements.filter(
        ({ id }) => !!deletedDifferences[id],
      );
      const deletedBoundElements = inserted.boundElements.filter(
        ({ id }) => !!insertedDifferences[id],
      );

      (deleted as Mutable<typeof deleted>).boundElements =
        insertedBoundElements;
      (inserted as Mutable<typeof inserted>).boundElements =
        deletedBoundElements;
    }

    if (deleted.groupIds && inserted.groupIds) {
      const deletedDifferences = arrayToObject(
        Delta.getLeftDifferences(
          arrayToObject(deleted.groupIds),
          arrayToObject(inserted.groupIds),
        ),
      );
      const insertedDifferences = arrayToObject(
        Delta.getRightDifferences(
          arrayToObject(deleted.groupIds),
          arrayToObject(inserted.groupIds),
        ),
      );

      const deletedGroupIds = deleted.groupIds.filter(
        (groupId) => !!deletedDifferences[groupId],
      );
      const insertedGroupIds = inserted.groupIds.filter(
        (groupId) => !!insertedDifferences[groupId],
      );

      (deleted as Mutable<typeof deleted>).groupIds = deletedGroupIds;
      (inserted as Mutable<typeof inserted>).groupIds = insertedGroupIds;
    }

    return [deleted, inserted];
  }

  private static stripIrrelevantProps(
    partial: Partial<OrderedExcalidrawElement>,
  ): ElementPartial {
    const { id, updated, version, versionNonce, seed, ...strippedPartial } =
      partial;

    return strippedPartial;
  }
}
