import {
  ExcalidrawLinearElement,
  ExcalidrawBindableElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
  PointBinding,
  ExcalidrawElement,
  ElementsMap,
  NonDeletedSceneElementsMap,
  ExcalidrawTextElement,
  ExcalidrawArrowElement,
} from "./types";
import { getElementAtPosition } from "../scene";
import { AppState } from "../types";
import {
  isArrowElement,
  isBindableElement,
  isBindingElement,
  isBoundToContainer,
  isLinearElement,
  isTextElement,
} from "./typeChecks";
import {
  bindingBorderTest,
  distanceToBindableElement,
  maxBindingGap,
  determineFocusDistance,
  intersectElementWithLine,
  determineFocusPoint,
} from "./collision";
import { ElementUpdate, mutateElement } from "./mutateElement";
import Scene from "../scene/Scene";
import { LinearElementEditor } from "./linearElementEditor";
import { arrayToMap, tupleToCoors } from "../utils";
import { KEYS } from "../keys";
import { handleBindTextResize } from "./textElement";

export type SuggestedBinding =
  | NonDeleted<ExcalidrawBindableElement>
  | SuggestedPointBinding;

export type SuggestedPointBinding = [
  NonDeleted<ExcalidrawLinearElement>,
  "start" | "end" | "both",
  NonDeleted<ExcalidrawBindableElement>,
];

export const shouldEnableBindingForPointerEvent = (
  event: React.PointerEvent<HTMLElement>,
) => {
  return !event[KEYS.CTRL_OR_CMD];
};

export const isBindingEnabled = (appState: AppState): boolean => {
  return appState.isBindingEnabled;
};

const getNonDeletedElements = (
  scene: Scene,
  ids: readonly ExcalidrawElement["id"][],
): NonDeleted<ExcalidrawElement>[] => {
  const result: NonDeleted<ExcalidrawElement>[] = [];
  ids.forEach((id) => {
    const element = scene.getNonDeletedElement(id);
    if (element != null) {
      result.push(element);
    }
  });
  return result;
};

export const bindOrUnbindLinearElement = (
  linearElement: NonDeleted<ExcalidrawLinearElement>,
  startBindingElement: ExcalidrawBindableElement | null | "keep",
  endBindingElement: ExcalidrawBindableElement | null | "keep",
  elementsMap: NonDeletedSceneElementsMap,
): void => {
  const boundToElementIds: Set<ExcalidrawBindableElement["id"]> = new Set();
  const unboundFromElementIds: Set<ExcalidrawBindableElement["id"]> = new Set();
  bindOrUnbindLinearElementEdge(
    linearElement,
    startBindingElement,
    endBindingElement,
    "start",
    boundToElementIds,
    unboundFromElementIds,
    elementsMap,
  );
  bindOrUnbindLinearElementEdge(
    linearElement,
    endBindingElement,
    startBindingElement,
    "end",
    boundToElementIds,
    unboundFromElementIds,
    elementsMap,
  );

  const onlyUnbound = Array.from(unboundFromElementIds).filter(
    (id) => !boundToElementIds.has(id),
  );

  getNonDeletedElements(Scene.getScene(linearElement)!, onlyUnbound).forEach(
    (element) => {
      mutateElement(element, {
        boundElements: element.boundElements?.filter(
          (element) =>
            element.type !== "arrow" || element.id !== linearElement.id,
        ),
      });
    },
  );
};

const bindOrUnbindLinearElementEdge = (
  linearElement: NonDeleted<ExcalidrawLinearElement>,
  bindableElement: ExcalidrawBindableElement | null | "keep",
  otherEdgeBindableElement: ExcalidrawBindableElement | null | "keep",
  startOrEnd: "start" | "end",
  // Is mutated
  boundToElementIds: Set<ExcalidrawBindableElement["id"]>,
  // Is mutated
  unboundFromElementIds: Set<ExcalidrawBindableElement["id"]>,
  elementsMap: NonDeletedSceneElementsMap,
): void => {
  if (bindableElement !== "keep") {
    if (bindableElement != null) {
      // Don't bind if we're trying to bind or are already bound to the same
      // element on the other edge already ("start" edge takes precedence).
      if (
        otherEdgeBindableElement == null ||
        (otherEdgeBindableElement === "keep"
          ? !isLinearElementSimpleAndAlreadyBoundOnOppositeEdge(
              linearElement,
              bindableElement,
              startOrEnd,
            )
          : startOrEnd === "start" ||
            otherEdgeBindableElement.id !== bindableElement.id)
      ) {
        bindLinearElement(
          linearElement,
          bindableElement,
          startOrEnd,
          elementsMap,
        );
        boundToElementIds.add(bindableElement.id);
      }
    } else {
      const unbound = unbindLinearElement(linearElement, startOrEnd);
      if (unbound != null) {
        unboundFromElementIds.add(unbound);
      }
    }
  }
};

export const bindOrUnbindSelectedElements = (
  selectedElements: NonDeleted<ExcalidrawElement>[],
  elements: readonly ExcalidrawElement[],
  elementsMap: NonDeletedSceneElementsMap,
): void => {
  selectedElements.forEach((selectedElement) => {
    if (isBindingElement(selectedElement)) {
      bindOrUnbindLinearElement(
        selectedElement,
        getElligibleElementForBindingElement(
          selectedElement,
          "start",
          elements,
          elementsMap,
        ),
        getElligibleElementForBindingElement(
          selectedElement,
          "end",
          elements,
          elementsMap,
        ),
        elementsMap,
      );
    } else if (isBindableElement(selectedElement)) {
      maybeBindBindableElement(selectedElement, elementsMap);
    }
  });
};

const maybeBindBindableElement = (
  bindableElement: NonDeleted<ExcalidrawBindableElement>,
  elementsMap: NonDeletedSceneElementsMap,
): void => {
  getElligibleElementsForBindableElementAndWhere(
    bindableElement,
    elementsMap,
  ).forEach(([linearElement, where]) =>
    bindOrUnbindLinearElement(
      linearElement,
      where === "end" ? "keep" : bindableElement,
      where === "start" ? "keep" : bindableElement,
      elementsMap,
    ),
  );
};

export const maybeBindLinearElement = (
  linearElement: NonDeleted<ExcalidrawLinearElement>,
  appState: AppState,
  scene: Scene,
  pointerCoords: { x: number; y: number },
  elementsMap: NonDeletedSceneElementsMap,
): void => {
  if (appState.startBoundElement != null) {
    bindLinearElement(
      linearElement,
      appState.startBoundElement,
      "start",
      elementsMap,
    );
  }
  const hoveredElement = getHoveredElementForBinding(
    pointerCoords,
    scene.getNonDeletedElements(),
    elementsMap,
  );
  if (
    hoveredElement != null &&
    !isLinearElementSimpleAndAlreadyBoundOnOppositeEdge(
      linearElement,
      hoveredElement,
      "end",
    )
  ) {
    bindLinearElement(linearElement, hoveredElement, "end", elementsMap);
  }
};

export const bindLinearElement = (
  linearElement: NonDeleted<ExcalidrawLinearElement>,
  hoveredElement: ExcalidrawBindableElement,
  startOrEnd: "start" | "end",
  elementsMap: NonDeletedSceneElementsMap,
): void => {
  mutateElement(linearElement, {
    [startOrEnd === "start" ? "startBinding" : "endBinding"]: {
      elementId: hoveredElement.id,
      ...calculateFocusAndGap(
        linearElement,
        hoveredElement,
        startOrEnd,
        elementsMap,
      ),
    } as PointBinding,
  });

  const boundElementsMap = arrayToMap(hoveredElement.boundElements || []);
  if (!boundElementsMap.has(linearElement.id)) {
    mutateElement(hoveredElement, {
      boundElements: (hoveredElement.boundElements || []).concat({
        id: linearElement.id,
        type: "arrow",
      }),
    });
  }
};

// Don't bind both ends of a simple segment
const isLinearElementSimpleAndAlreadyBoundOnOppositeEdge = (
  linearElement: NonDeleted<ExcalidrawLinearElement>,
  bindableElement: ExcalidrawBindableElement,
  startOrEnd: "start" | "end",
): boolean => {
  const otherBinding =
    linearElement[startOrEnd === "start" ? "endBinding" : "startBinding"];
  return isLinearElementSimpleAndAlreadyBound(
    linearElement,
    otherBinding?.elementId,
    bindableElement,
  );
};

export const isLinearElementSimpleAndAlreadyBound = (
  linearElement: NonDeleted<ExcalidrawLinearElement>,
  alreadyBoundToId: ExcalidrawBindableElement["id"] | undefined,
  bindableElement: ExcalidrawBindableElement,
): boolean => {
  return (
    alreadyBoundToId === bindableElement.id && linearElement.points.length < 3
  );
};

export const unbindLinearElements = (
  elements: NonDeleted<ExcalidrawElement>[],
  elementsMap: NonDeletedSceneElementsMap,
): void => {
  elements.forEach((element) => {
    if (isBindingElement(element)) {
      bindOrUnbindLinearElement(element, null, null, elementsMap);
    }
  });
};

const unbindLinearElement = (
  linearElement: NonDeleted<ExcalidrawLinearElement>,
  startOrEnd: "start" | "end",
): ExcalidrawBindableElement["id"] | null => {
  const field = startOrEnd === "start" ? "startBinding" : "endBinding";
  const binding = linearElement[field];
  if (binding == null) {
    return null;
  }
  mutateElement(linearElement, { [field]: null });
  return binding.elementId;
};

export const getHoveredElementForBinding = (
  pointerCoords: {
    x: number;
    y: number;
  },
  elements: readonly NonDeletedExcalidrawElement[],
  elementsMap: NonDeletedSceneElementsMap,
): NonDeleted<ExcalidrawBindableElement> | null => {
  const hoveredElement = getElementAtPosition(
    elements,
    (element) =>
      isBindableElement(element, false) &&
      bindingBorderTest(element, pointerCoords, elementsMap),
  );
  return hoveredElement as NonDeleted<ExcalidrawBindableElement> | null;
};

const calculateFocusAndGap = (
  linearElement: NonDeleted<ExcalidrawLinearElement>,
  hoveredElement: ExcalidrawBindableElement,
  startOrEnd: "start" | "end",
  elementsMap: NonDeletedSceneElementsMap,
): { focus: number; gap: number } => {
  const direction = startOrEnd === "start" ? -1 : 1;
  const edgePointIndex = direction === -1 ? 0 : linearElement.points.length - 1;
  const adjacentPointIndex = edgePointIndex - direction;

  const edgePoint = LinearElementEditor.getPointAtIndexGlobalCoordinates(
    linearElement,
    edgePointIndex,
    elementsMap,
  );
  const adjacentPoint = LinearElementEditor.getPointAtIndexGlobalCoordinates(
    linearElement,
    adjacentPointIndex,
    elementsMap,
  );
  return {
    focus: determineFocusDistance(
      hoveredElement,
      adjacentPoint,
      edgePoint,
      elementsMap,
    ),
    gap: Math.max(
      1,
      distanceToBindableElement(hoveredElement, edgePoint, elementsMap),
    ),
  };
};

// Supports translating, rotating and scaling `changedElement` with bound
// linear elements.
// Because scaling involves moving the focus points as well, it is
// done before the `changedElement` is updated, and the `newSize` is passed
// in explicitly.
export const updateBoundElements = (
  changedElement: NonDeletedExcalidrawElement,
  elementsMap: ElementsMap,
  options?: {
    simultaneouslyUpdated?: readonly ExcalidrawElement[];
    newSize?: { width: number; height: number };
  },
) => {
  const { newSize, simultaneouslyUpdated } = options ?? {};
  const simultaneouslyUpdatedElementIds = getSimultaneouslyUpdatedElementIds(
    simultaneouslyUpdated,
  );

  boundElementsVisitor(elementsMap, changedElement, (element) => {
    if (!isLinearElement(element) || element.isDeleted) {
      return;
    }

    const bindableElement = changedElement as ExcalidrawBindableElement;
    // In case the boundElements are stale
    if (!doesNeedUpdate(element, bindableElement)) {
      return;
    }
    const bindings = {
      startBinding: maybeCalculateNewGapWhenScaling(
        bindableElement,
        element.startBinding,
        newSize,
      ),
      endBinding: maybeCalculateNewGapWhenScaling(
        bindableElement,
        element.endBinding,
        newSize,
      ),
    };

    // `linearElement` is being moved/scaled already, just update the binding
    if (simultaneouslyUpdatedElementIds.has(element.id)) {
      mutateElement(element, bindings);
      return;
    }

    bindableElementsVisitor(
      elementsMap,
      element,
      (bindableElement, bindingProp) => {
        if (
          bindableElement &&
          isBindableElement(bindableElement) &&
          (bindingProp === "startBinding" || bindingProp === "endBinding")
        ) {
          updateBoundPoint(
            element,
            bindingProp,
            bindings[bindingProp],
            bindableElement,
            elementsMap,
          );
        }
      },
    );

    boundElementsVisitor(elementsMap, element, (boundElement) => {
      if (
        boundElement &&
        isTextElement(boundElement) &&
        !boundElement.isDeleted
      ) {
        handleBindTextResize(element, elementsMap, false);
      }
    });
  });
};

const doesNeedUpdate = (
  boundElement: NonDeleted<ExcalidrawLinearElement>,
  changedElement: ExcalidrawBindableElement,
) => {
  return (
    boundElement.startBinding?.elementId === changedElement.id ||
    boundElement.endBinding?.elementId === changedElement.id
  );
};

const getSimultaneouslyUpdatedElementIds = (
  simultaneouslyUpdated: readonly ExcalidrawElement[] | undefined,
): Set<ExcalidrawElement["id"]> => {
  return new Set((simultaneouslyUpdated || []).map((element) => element.id));
};

const updateBoundPoint = (
  linearElement: NonDeleted<ExcalidrawLinearElement>,
  startOrEnd: "startBinding" | "endBinding",
  binding: PointBinding | null | undefined,
  bindableElement: ExcalidrawBindableElement,
  elementsMap: ElementsMap,
): void => {
  if (
    binding == null ||
    // We only need to update the other end if this is a 2 point line element
    (binding.elementId !== bindableElement.id &&
      linearElement.points.length > 2)
  ) {
    return;
  }

  const direction = startOrEnd === "startBinding" ? -1 : 1;
  const edgePointIndex = direction === -1 ? 0 : linearElement.points.length - 1;
  const adjacentPointIndex = edgePointIndex - direction;
  const adjacentPoint = LinearElementEditor.getPointAtIndexGlobalCoordinates(
    linearElement,
    adjacentPointIndex,
    elementsMap,
  );
  const focusPointAbsolute = determineFocusPoint(
    bindableElement,
    binding.focus,
    adjacentPoint,
    elementsMap,
  );
  let newEdgePoint;
  // The linear element was not originally pointing inside the bound shape,
  // we can point directly at the focus point
  if (binding.gap === 0) {
    newEdgePoint = focusPointAbsolute;
  } else {
    const intersections = intersectElementWithLine(
      bindableElement,
      adjacentPoint,
      focusPointAbsolute,
      binding.gap,
      elementsMap,
    );
    if (intersections.length === 0) {
      // This should never happen, since focusPoint should always be
      // inside the element, but just in case, bail out
      newEdgePoint = focusPointAbsolute;
    } else {
      // Guaranteed to intersect because focusPoint is always inside the shape
      newEdgePoint = intersections[0];
    }
  }
  LinearElementEditor.movePoints(
    linearElement,
    [
      {
        index: edgePointIndex,
        point: LinearElementEditor.pointFromAbsoluteCoords(
          linearElement,
          newEdgePoint,
          elementsMap,
        ),
      },
    ],
    { [startOrEnd]: binding },
  );
};

const maybeCalculateNewGapWhenScaling = (
  changedElement: ExcalidrawBindableElement,
  currentBinding: PointBinding | null | undefined,
  newSize: { width: number; height: number } | undefined,
): PointBinding | null | undefined => {
  if (currentBinding == null || newSize == null) {
    return currentBinding;
  }
  const { gap, focus, elementId } = currentBinding;
  const { width: newWidth, height: newHeight } = newSize;
  const { width, height } = changedElement;
  const newGap = Math.max(
    1,
    Math.min(
      maxBindingGap(changedElement, newWidth, newHeight),
      gap * (newWidth < newHeight ? newWidth / width : newHeight / height),
    ),
  );
  return { elementId, gap: newGap, focus };
};

// TODO: this is a bottleneck, optimise
export const getEligibleElementsForBinding = (
  selectedElements: NonDeleted<ExcalidrawElement>[],
  elements: readonly ExcalidrawElement[],
  elementsMap: NonDeletedSceneElementsMap,
): SuggestedBinding[] => {
  const includedElementIds = new Set(selectedElements.map(({ id }) => id));
  return selectedElements.flatMap((selectedElement) =>
    isBindingElement(selectedElement, false)
      ? (getElligibleElementsForBindingElement(
          selectedElement as NonDeleted<ExcalidrawLinearElement>,
          elements,
          elementsMap,
        ).filter(
          (element) => !includedElementIds.has(element.id),
        ) as SuggestedBinding[])
      : isBindableElement(selectedElement, false)
      ? getElligibleElementsForBindableElementAndWhere(
          selectedElement,
          elementsMap,
        ).filter((binding) => !includedElementIds.has(binding[0].id))
      : [],
  );
};

const getElligibleElementsForBindingElement = (
  linearElement: NonDeleted<ExcalidrawLinearElement>,
  elements: readonly ExcalidrawElement[],
  elementsMap: NonDeletedSceneElementsMap,
): NonDeleted<ExcalidrawBindableElement>[] => {
  return [
    getElligibleElementForBindingElement(
      linearElement,
      "start",
      elements,
      elementsMap,
    ),
    getElligibleElementForBindingElement(
      linearElement,
      "end",
      elements,
      elementsMap,
    ),
  ].filter(
    (element): element is NonDeleted<ExcalidrawBindableElement> =>
      element != null,
  );
};

const getElligibleElementForBindingElement = (
  linearElement: NonDeleted<ExcalidrawLinearElement>,
  startOrEnd: "start" | "end",
  elements: readonly ExcalidrawElement[],
  elementsMap: NonDeletedSceneElementsMap,
): NonDeleted<ExcalidrawBindableElement> | null => {
  return getHoveredElementForBinding(
    getLinearElementEdgeCoors(linearElement, startOrEnd, elementsMap),
    elements,
    elementsMap,
  );
};

const getLinearElementEdgeCoors = (
  linearElement: NonDeleted<ExcalidrawLinearElement>,
  startOrEnd: "start" | "end",
  elementsMap: NonDeletedSceneElementsMap,
): { x: number; y: number } => {
  const index = startOrEnd === "start" ? 0 : -1;
  return tupleToCoors(
    LinearElementEditor.getPointAtIndexGlobalCoordinates(
      linearElement,
      index,
      elementsMap,
    ),
  );
};

const getElligibleElementsForBindableElementAndWhere = (
  bindableElement: NonDeleted<ExcalidrawBindableElement>,
  elementsMap: NonDeletedSceneElementsMap,
): SuggestedPointBinding[] => {
  const scene = Scene.getScene(bindableElement)!;
  return scene
    .getNonDeletedElements()
    .map((element) => {
      if (!isBindingElement(element, false)) {
        return null;
      }
      const canBindStart = isLinearElementEligibleForNewBindingByBindable(
        element,
        "start",
        bindableElement,
        elementsMap,
      );
      const canBindEnd = isLinearElementEligibleForNewBindingByBindable(
        element,
        "end",
        bindableElement,
        elementsMap,
      );
      if (!canBindStart && !canBindEnd) {
        return null;
      }
      return [
        element,
        canBindStart && canBindEnd ? "both" : canBindStart ? "start" : "end",
        bindableElement,
      ];
    })
    .filter((maybeElement) => maybeElement != null) as SuggestedPointBinding[];
};

const isLinearElementEligibleForNewBindingByBindable = (
  linearElement: NonDeleted<ExcalidrawLinearElement>,
  startOrEnd: "start" | "end",
  bindableElement: NonDeleted<ExcalidrawBindableElement>,
  elementsMap: NonDeletedSceneElementsMap,
): boolean => {
  const existingBinding =
    linearElement[startOrEnd === "start" ? "startBinding" : "endBinding"];
  return (
    existingBinding == null &&
    !isLinearElementSimpleAndAlreadyBoundOnOppositeEdge(
      linearElement,
      bindableElement,
      startOrEnd,
    ) &&
    bindingBorderTest(
      bindableElement,
      getLinearElementEdgeCoors(linearElement, startOrEnd, elementsMap),
      elementsMap,
    )
  );
};

// We need to:
// 1: Update elements not selected to point to duplicated elements
// 2: Update duplicated elements to point to other duplicated elements
export const fixBindingsAfterDuplication = (
  sceneElements: readonly ExcalidrawElement[],
  oldElements: readonly ExcalidrawElement[],
  oldIdToDuplicatedId: Map<ExcalidrawElement["id"], ExcalidrawElement["id"]>,
  // There are three copying mechanisms: Copy-paste, duplication and alt-drag.
  // Only when alt-dragging the new "duplicates" act as the "old", while
  // the "old" elements act as the "new copy" - essentially working reverse
  // to the other two.
  duplicatesServeAsOld?: "duplicatesServeAsOld" | undefined,
): void => {
  // First collect all the binding/bindable elements, so we only update
  // each once, regardless of whether they were duplicated or not.
  const allBoundElementIds: Set<ExcalidrawElement["id"]> = new Set();
  const allBindableElementIds: Set<ExcalidrawElement["id"]> = new Set();
  const shouldReverseRoles = duplicatesServeAsOld === "duplicatesServeAsOld";
  oldElements.forEach((oldElement) => {
    const { boundElements } = oldElement;
    if (boundElements != null && boundElements.length > 0) {
      boundElements.forEach((boundElement) => {
        if (shouldReverseRoles && !oldIdToDuplicatedId.has(boundElement.id)) {
          allBoundElementIds.add(boundElement.id);
        }
      });
      allBindableElementIds.add(oldIdToDuplicatedId.get(oldElement.id)!);
    }
    if (isBindingElement(oldElement)) {
      if (oldElement.startBinding != null) {
        const { elementId } = oldElement.startBinding;
        if (shouldReverseRoles && !oldIdToDuplicatedId.has(elementId)) {
          allBindableElementIds.add(elementId);
        }
      }
      if (oldElement.endBinding != null) {
        const { elementId } = oldElement.endBinding;
        if (shouldReverseRoles && !oldIdToDuplicatedId.has(elementId)) {
          allBindableElementIds.add(elementId);
        }
      }
      if (oldElement.startBinding != null || oldElement.endBinding != null) {
        allBoundElementIds.add(oldIdToDuplicatedId.get(oldElement.id)!);
      }
    }
  });

  // Update the linear elements
  (
    sceneElements.filter(({ id }) =>
      allBoundElementIds.has(id),
    ) as ExcalidrawLinearElement[]
  ).forEach((element) => {
    const { startBinding, endBinding } = element;
    mutateElement(element, {
      startBinding: newBindingAfterDuplication(
        startBinding,
        oldIdToDuplicatedId,
      ),
      endBinding: newBindingAfterDuplication(endBinding, oldIdToDuplicatedId),
    });
  });

  // Update the bindable shapes
  sceneElements
    .filter(({ id }) => allBindableElementIds.has(id))
    .forEach((bindableElement) => {
      const { boundElements } = bindableElement;
      if (boundElements != null && boundElements.length > 0) {
        mutateElement(bindableElement, {
          boundElements: boundElements.map((boundElement) =>
            oldIdToDuplicatedId.has(boundElement.id)
              ? {
                  id: oldIdToDuplicatedId.get(boundElement.id)!,
                  type: boundElement.type,
                }
              : boundElement,
          ),
        });
      }
    });
};

const newBindingAfterDuplication = (
  binding: PointBinding | null,
  oldIdToDuplicatedId: Map<ExcalidrawElement["id"], ExcalidrawElement["id"]>,
): PointBinding | null => {
  if (binding == null) {
    return null;
  }
  const { elementId, focus, gap } = binding;
  return {
    focus,
    gap,
    elementId: oldIdToDuplicatedId.get(elementId) ?? elementId,
  };
};

export const fixBindingsAfterDeletion = (
  sceneElements: readonly ExcalidrawElement[],
  deletedElements: readonly ExcalidrawElement[],
): void => {
  const elements = arrayToMap(sceneElements);

  for (const element of deletedElements) {
    BoundElement.unbindAffected(elements, element, mutateElement);
    BindableElement.unbindAffected(elements, element, mutateElement);
  }
};

const newBoundElements = (
  boundElements: ExcalidrawElement["boundElements"],
  idsToRemove: Set<ExcalidrawElement["id"]>,
  elementsToAdd: Array<ExcalidrawElement> = [],
) => {
  if (!boundElements) {
    return null;
  }

  const nextBoundElements = boundElements.filter(
    (boundElement) => !idsToRemove.has(boundElement.id),
  );

  nextBoundElements.push(
    ...elementsToAdd.map(
      (x) =>
        ({ id: x.id, type: x.type } as
          | ExcalidrawArrowElement
          | ExcalidrawTextElement),
    ),
  );

  return nextBoundElements;
};

export const bindingProperties: Set<BindableProp | BindingProp> = new Set([
  "boundElements",
  "frameId",
  "containerId",
  "startBinding",
  "endBinding",
]);

export type BindableProp = "boundElements";

export type BindingProp =
  | "frameId"
  | "containerId"
  | "startBinding"
  | "endBinding";

type BoundElementsVisitingFunc = (
  boundElement: ExcalidrawElement | undefined,
  bindingProp: BindableProp,
  bindingId: string,
) => void;

type BindableElementVisitingFunc = (
  bindableElement: ExcalidrawElement | undefined,
  bindingProp: BindingProp,
  bindingId: string,
) => void;

/**
 * Tries to visit each bound element (does not have to be found).
 */
const boundElementsVisitor = (
  elements: ElementsMap,
  element: ExcalidrawElement,
  visit: BoundElementsVisitingFunc,
) => {
  if (isBindableElement(element)) {
    // create new instance so that possible mutations won't play a role in visiting order
    const boundElements = element.boundElements?.slice() ?? [];

    // last added text should be the one we keep (~previous are duplicates)
    boundElements.forEach(({ id }) => {
      visit(elements.get(id), "boundElements", id);
    });
  }
};

/**
 * Tries to visit each bindable element (does not have to be found).
 */
const bindableElementsVisitor = (
  elements: ElementsMap,
  element: ExcalidrawElement,
  visit: BindableElementVisitingFunc,
) => {
  if (element.frameId) {
    const id = element.frameId;
    visit(elements.get(id), "frameId", id);
  }

  if (isBoundToContainer(element)) {
    const id = element.containerId;
    visit(elements.get(id), "containerId", id);
  }

  if (isArrowElement(element)) {
    if (element.startBinding) {
      const id = element.startBinding.elementId;
      visit(elements.get(id), "startBinding", id);
    }

    if (element.endBinding) {
      const id = element.endBinding.elementId;
      visit(elements.get(id), "endBinding", id);
    }
  }
};

/**
 * Bound element containing bindings to `frameId`, `containerId`, `startBinding` or `endBinding`.
 */
export class BoundElement {
  /**
   * Unbind the affected non deleted bindable elements (removing element from `boundElements`).
   * - iterates non deleted bindable elements (`containerId` | `startBinding.elementId` | `endBinding.elementId`) of the current element
   * - prepares updates to unbind each bindable element's `boundElements` from the current element
   */
  public static unbindAffected(
    elements: ElementsMap,
    boundElement: ExcalidrawElement | undefined,
    updateElementWith: (
      affected: ExcalidrawElement,
      updates: ElementUpdate<ExcalidrawElement>,
    ) => void,
  ) {
    if (!boundElement) {
      return;
    }

    bindableElementsVisitor(elements, boundElement, (bindableElement) => {
      // bindable element is deleted, this is fine
      if (!bindableElement || bindableElement.isDeleted) {
        return;
      }

      boundElementsVisitor(
        elements,
        bindableElement,
        (_, __, boundElementId) => {
          if (boundElementId === boundElement.id) {
            updateElementWith(bindableElement, {
              boundElements: newBoundElements(
                bindableElement.boundElements,
                new Set([boundElementId]),
              ),
            });
          }
        },
      );
    });
  }

  /**
   * Rebind the next affected non deleted bindable elements (adding element to `boundElements`).
   * - iterates non deleted bindable elements (`containerId` | `startBinding.elementId` | `endBinding.elementId`) of the current element
   * - prepares updates to rebind each bindable element's `boundElements` to the current element
   *
   * NOTE: rebind expects that affected elements were previously unbound with `BoundElement.unbindAffected`
   */
  public static rebindAffected = (
    elements: ElementsMap,
    boundElement: ExcalidrawElement | undefined,
    updateElementWith: (
      affected: ExcalidrawElement,
      updates: ElementUpdate<ExcalidrawElement>,
    ) => void,
  ) => {
    // don't try to rebind element that is deleted
    if (!boundElement || boundElement.isDeleted) {
      return;
    }

    bindableElementsVisitor(
      elements,
      boundElement,
      (bindableElement, bindingProp) => {
        // unbind from bindable elements, as bindings from non deleted elements into deleted elements are incorrect
        if (!bindableElement || bindableElement.isDeleted) {
          updateElementWith(boundElement, { [bindingProp]: null });
          return;
        }

        // frame bindings are unidirectional, there is nothing to rebind
        if (bindingProp === "frameId") {
          return;
        }

        if (
          bindableElement.boundElements?.find((x) => x.id === boundElement.id)
        ) {
          return;
        }

        if (isArrowElement(boundElement)) {
          // rebind if not found!
          updateElementWith(bindableElement, {
            boundElements: newBoundElements(
              bindableElement.boundElements,
              new Set(),
              new Array(boundElement),
            ),
          });
        }

        if (isTextElement(boundElement)) {
          if (!bindableElement.boundElements?.find((x) => x.type === "text")) {
            // rebind only if there is no other text bound already
            updateElementWith(bindableElement, {
              boundElements: newBoundElements(
                bindableElement.boundElements,
                new Set(),
                new Array(boundElement),
              ),
            });
          } else {
            // unbind otherwise
            updateElementWith(boundElement, { [bindingProp]: null });
          }
        }
      },
    );
  };
}

/**
 * Bindable element containing bindings to `boundElements`.
 */
export class BindableElement {
  /**
   * Unbind the affected non deleted bound elements (resetting `containerId`, `startBinding`, `endBinding` to `null`).
   * - iterates through non deleted `boundElements` of the current element
   * - prepares updates to unbind each bound element from the current element
   */
  public static unbindAffected(
    elements: ElementsMap,
    bindableElement: ExcalidrawElement | undefined,
    updateElementWith: (
      affected: ExcalidrawElement,
      updates: ElementUpdate<ExcalidrawElement>,
    ) => void,
  ) {
    if (!bindableElement) {
      return;
    }

    boundElementsVisitor(elements, bindableElement, (boundElement) => {
      // bound element is deleted, this is fine
      if (!boundElement || boundElement.isDeleted) {
        return;
      }

      bindableElementsVisitor(
        elements,
        boundElement,
        (_, bindingProp, bindableElementId) => {
          // making sure there is an element to be unbound
          if (bindableElementId === bindableElement.id) {
            updateElementWith(boundElement, { [bindingProp]: null });
          }
        },
      );
    });
  }

  /**
   * Rebind the affected non deleted bound elements (for now setting only `containerId`, as we cannot rebind arrows atm).
   * - iterates through non deleted `boundElements` of the current element
   * - prepares updates to rebind each bound element to the current element or unbind it from `boundElements` in case of conflicts
   *
   * NOTE: rebind expects that affected elements were previously unbound with `BindaleElement.unbindAffected`
   */
  public static rebindAffected = (
    elements: ElementsMap,
    bindableElement: ExcalidrawElement | undefined,
    updateElementWith: (
      affected: ExcalidrawElement,
      updates: ElementUpdate<ExcalidrawElement>,
    ) => void,
  ) => {
    // don't try to rebind element that is deleted (i.e. updated as deleted)
    if (!bindableElement || bindableElement.isDeleted) {
      return;
    }

    boundElementsVisitor(
      elements,
      bindableElement,
      (boundElement, _, boundElementId) => {
        // unbind from bindable elements, as bindings from non deleted elements into deleted elements are incorrect
        if (!boundElement || boundElement.isDeleted) {
          updateElementWith(bindableElement, {
            boundElements: newBoundElements(
              bindableElement.boundElements,
              new Set([boundElementId]),
            ),
          });
          return;
        }

        if (isTextElement(boundElement)) {
          // check if this is the last element in the array, if not, it's a duplicated text which should be unbound
          if (
            bindableElement.boundElements?.findLast((x) => x.type === "text")
              ?.id === boundElement.id
          ) {
            if (boundElement.containerId !== bindableElement.id) {
              // rebind if not bound already!
              updateElementWith(boundElement, {
                containerId: bindableElement.id,
              } as ElementUpdate<ExcalidrawTextElement>);
            }
          } else {
            if (boundElement.containerId !== null) {
              // unbind if not unbound already
              updateElementWith(boundElement, {
                containerId: null,
              } as ElementUpdate<ExcalidrawTextElement>);
            }

            // unbind from boundElements as the element got bound to some other element in the meantime
            updateElementWith(bindableElement, {
              boundElements: newBoundElements(
                bindableElement.boundElements,
                new Set([boundElement.id]),
              ),
            });
          }
        }
      },
    );
  };
}
