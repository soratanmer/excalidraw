import {
  ExcalidrawLinearElement,
  ExcalidrawBindableElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
  PointBinding,
  ExcalidrawElement,
  ElementsMap,
  NonDeletedSceneElementsMap,
  SceneElementsMap,
  OrderedExcalidrawElement,
  ExcalidrawTextElement,
  ExcalidrawArrowElement,
  Ordered,
} from "./types";
import { getElementAtPosition } from "../scene";
import { AppState } from "../types";
import {
  isBindableElement,
  isBindingElement,
  isBoundToContainer,
  isLinearElement,
} from "./typeChecks";
import {
  bindingBorderTest,
  distanceToBindableElement,
  maxBindingGap,
  determineFocusDistance,
  intersectElementWithLine,
  determineFocusPoint,
} from "./collision";
import { mutateElement } from "./mutateElement";
import Scene from "../scene/Scene";
import { LinearElementEditor } from "./linearElementEditor";
import { arrayToMap, tupleToCoors } from "../utils";
import { KEYS } from "../keys";
import { getBoundTextElement, handleBindTextResize } from "./textElement";

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
  const boundLinearElements = (changedElement.boundElements ?? []).filter(
    (el) => el.type === "arrow",
  );
  if (boundLinearElements.length === 0) {
    return;
  }
  const { newSize, simultaneouslyUpdated } = options ?? {};
  const simultaneouslyUpdatedElementIds = getSimultaneouslyUpdatedElementIds(
    simultaneouslyUpdated,
  );
  const scene = Scene.getScene(changedElement)!;
  getNonDeletedElements(
    scene,
    boundLinearElements.map((el) => el.id),
  ).forEach((element) => {
    if (!isLinearElement(element)) {
      return;
    }

    const bindableElement = changedElement as ExcalidrawBindableElement;
    // In case the boundElements are stale
    if (!doesNeedUpdate(element, bindableElement)) {
      return;
    }
    const startBinding = maybeCalculateNewGapWhenScaling(
      bindableElement,
      element.startBinding,
      newSize,
    );
    const endBinding = maybeCalculateNewGapWhenScaling(
      bindableElement,
      element.endBinding,
      newSize,
    );
    // `linearElement` is being moved/scaled already, just update the binding
    if (simultaneouslyUpdatedElementIds.has(element.id)) {
      mutateElement(element, { startBinding, endBinding });
      return;
    }
    updateBoundPoint(
      element,
      "start",
      startBinding,
      changedElement as ExcalidrawBindableElement,
      elementsMap,
    );
    updateBoundPoint(
      element,
      "end",
      endBinding,
      changedElement as ExcalidrawBindableElement,
      elementsMap,
    );
    const boundText = getBoundTextElement(
      element,
      scene.getNonDeletedElementsMap(),
    );
    if (boundText) {
      handleBindTextResize(element, scene.getNonDeletedElementsMap(), false);
    }
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
  startOrEnd: "start" | "end",
  binding: PointBinding | null | undefined,
  changedElement: ExcalidrawBindableElement,
  elementsMap: ElementsMap,
): void => {
  if (
    binding == null ||
    // We only need to update the other end if this is a 2 point line element
    (binding.elementId !== changedElement.id && linearElement.points.length > 2)
  ) {
    return;
  }
  const bindingElement = Scene.getScene(linearElement)!.getElement(
    binding.elementId,
  ) as ExcalidrawBindableElement | null;
  if (bindingElement == null) {
    // We're not cleaning up after deleted elements atm., so handle this case
    return;
  }
  const direction = startOrEnd === "start" ? -1 : 1;
  const edgePointIndex = direction === -1 ? 0 : linearElement.points.length - 1;
  const adjacentPointIndex = edgePointIndex - direction;
  const adjacentPoint = LinearElementEditor.getPointAtIndexGlobalCoordinates(
    linearElement,
    adjacentPointIndex,
    elementsMap,
  );
  const focusPointAbsolute = determineFocusPoint(
    bindingElement,
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
      bindingElement,
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
    { [startOrEnd === "start" ? "startBinding" : "endBinding"]: binding },
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

export class BindingsCleaner {
  public static cleanChanged(
    elements: SceneElementsMap,
    changed: Map<string, OrderedExcalidrawElement>,
    callback: (affectedElement: OrderedExcalidrawElement) => void,
  ) {
    for (const element of changed.values()) {
      this.cleanElement(elements, element, callback);
    }
  }

  public static cleanElement(
    elements: SceneElementsMap,
    element: OrderedExcalidrawElement,
    callback: (affectedElement: OrderedExcalidrawElement) => void,
  ) {
    if (element.frameId) {
      const frame = elements.get(element.frameId);
      if (!frame || frame.isDeleted) {
        callback(mutateElement(element, { frameId: null }, false));
      }
    }

    if (isBoundToContainer(element)) {
      const bindable = elements.get(element.containerId);
      this.maybeUnbindBoundElement(element, "containerId", bindable, callback);
      this.maybeUnbindBindableElement(bindable, element, callback);
    }

    if (isBindingElement(element)) {
      if (element.startBinding) {
        const bindable = elements.get(element.startBinding.elementId);
        this.maybeUnbindBoundElement(
          element,
          "startBinding",
          bindable,
          callback,
        );
        this.maybeUnbindBindableElement(bindable, element, callback);
      }

      if (element.endBinding) {
        const bindable = elements.get(element.endBinding.elementId);
        this.maybeUnbindBoundElement(element, "endBinding", bindable, callback);
        this.maybeUnbindBindableElement(bindable, element, callback);
      }
    }

    if (isBindableElement(element)) {
      element.boundElements?.forEach(({ id }) => {
        const boundElement = elements.get(id);
        this.maybeUnbindBoundElement(
          boundElement,
          "containerId",
          element,
          callback,
        );
        this.maybeUnbindBoundElement(
          boundElement,
          "startBinding",
          element,
          callback,
        );
        this.maybeUnbindBoundElement(
          boundElement,
          "endBinding",
          element,
          callback,
        );
      });

      const textElements =
        element.boundElements?.filter((x) => x.type === "text") ?? [];

      if (textElements.length > 1) {
        // deduplicate ~ remove all but first text element
        textElements.shift();

        callback(
          mutateElement(element, {
            boundElements: newBoundElements(
              element.boundElements,
              new Set(textElements.map((x) => x.id)),
            ),
          }),
        );
      }
    }
  }

  private static maybeUnbindBoundElement = (
    element: OrderedExcalidrawElement | undefined,
    bindingProperty: BindingProp | BindableProp,
    bindableElement: OrderedExcalidrawElement | undefined,
    callback: (affectedElement: OrderedExcalidrawElement) => void,
  ) => {
    if (!bindableElement || bindableElement.isDeleted) {
      callback(
        mutateElement(
          element as Ordered<ExcalidrawTextElement>,
          { [bindingProperty]: null },
          false,
        ),
      );
    }
  };

  private static maybeUnbindBindableElement = (
    bindableElement: OrderedExcalidrawElement | undefined,
    boundElement: OrderedExcalidrawElement,
    callback: (affectedElement: OrderedExcalidrawElement) => void,
  ) => {
    if (bindableElement) {
      if (
        !bindableElement.boundElements?.find((x) => x.id === boundElement.id)
      ) {
        callback(
          mutateElement(
            bindableElement,
            {
              boundElements: newBoundElements(
                bindableElement.boundElements,
                new Set(boundElement.id),
              ),
            },
            false,
          ),
        );
      }
    }
  };
}

type BindingProp = "containerId" | "startBinding" | "endBinding";
type BindableElementVisitingFunc = (
  bindableElement: OrderedExcalidrawElement,
  bindingProperty: BindingProp,
) => void;

type BindableProp = "boundElements";
type BoundElementsVisitingFunc = (
  boundElement: OrderedExcalidrawElement,
  bindingProperty: BindableProp,
) => void;

const bindableElementsVisitor = (
  element: ExcalidrawElement,
  elements: SceneElementsMap,
  visit: BindableElementVisitingFunc,
) => {
  if (isBoundToContainer(element)) {
    const bindableContainer = elements.get(element.containerId);

    if (bindableContainer && !bindableContainer.isDeleted) {
      visit(bindableContainer, "containerId");
    }
  }

  if (isBindingElement(element)) {
    if (element.startBinding) {
      const bindableElement = elements.get(element.startBinding.elementId);

      if (bindableElement && !bindableElement.isDeleted) {
        visit(bindableElement, "startBinding");
      }
    }

    if (element.endBinding) {
      const bindableElement = elements.get(element.endBinding.elementId);

      if (bindableElement && !bindableElement.isDeleted) {
        visit(bindableElement, "endBinding");
      }
    }
  }
};

const boundElementsVisitor = (
  element: ExcalidrawElement,
  elements: SceneElementsMap,
  visit: BoundElementsVisitingFunc,
) => {
  if (isBindableElement(element)) {
    element.boundElements?.forEach(({ id }) => {
      const boundElement = elements.get(id);

      if (boundElement && !boundElement.isDeleted) {
        visit(boundElement, "boundElements");
      }
    });
  }
};

export class AffectedBoundElements {
  /**
   * - iterates through `boundElements` of the current element
   * - unbinds (mutates) each bound element from the current element
   * - returns mutated elements as affected elements
   */
  public static unbind(
    element: OrderedExcalidrawElement,
    elements: SceneElementsMap,
    callback: (affectedElement: OrderedExcalidrawElement) => void,
  ) {
    boundElementsVisitor(element, elements, (boundElement) => {
      bindableElementsVisitor(
        boundElement,
        elements,
        (bindableElement, bindingProperty) => {
          // making sure there is an element to be unbound
          if (bindableElement.id === element.id) {
            callback(
              mutateElement(element, { [bindingProperty]: null }, false),
            );
          }
        },
      );
    });
  }

  /**
   * - iterates through `boundElements` of the current element
   * - rebinds (mutates) each bound element to the current element
   * - returns mutated elements as affected elements
   */
  public static rebind = (
    element: OrderedExcalidrawElement,
    elements: SceneElementsMap,
    callback: (affectedElement: OrderedExcalidrawElement) => void,
  ) => {
    boundElementsVisitor(element, elements, (boundElement) => {
      // this one is a bit tricky, as we:
      // - want to rebind only in case the bindings are not defined, so that we don't override already valid bindings
      // - cannot rebind arrows, as we don't have a contextual info on the boundElement level (i.e. in case it's start / end binding)
      // TODO: add startBinding / endBinding to the `BoundElement` so that we could rebind arrows
      if (
        boundElement.type === "text" &&
        boundElement.containerId !== element.id
      ) {
        if (boundElement.containerId === null) {
          // rebind with the container in case the element is not bound
          callback(
            mutateElement(boundElement, { containerId: element.id }, false),
          );
        } else {
          // unbind from boundElements as the element is bound to some other element (could have happened in the meantime)
          callback(
            mutateElement(
              element,
              {
                boundElements: newBoundElements(
                  element.boundElements,
                  new Set(boundElement.id),
                ),
              },
              false,
            ),
          );
        }
      }
    });
  };
}

export class AffectedBindableElements {
  /**
   * - iterates bindable elements (`containerId` | `startBinding.elementId` | `endBinding.elementId`) of the current element
   * - unbinds (mutates) each bindable element's `boundElements` from the current element
   * - returns mutated elements as affected elements
   */
  public static unbind(
    element: OrderedExcalidrawElement,
    elements: SceneElementsMap,
    callback: (affectedElement: OrderedExcalidrawElement) => void,
  ) {
    bindableElementsVisitor(element, elements, (bindableElement) => {
      boundElementsVisitor(bindableElement, elements, (boundElement) => {
        if (boundElement.id === element.id) {
          callback(
            mutateElement(
              bindableElement,
              {
                boundElements: newBoundElements(
                  bindableElement.boundElements,
                  new Set(boundElement.id),
                ),
              },
              false,
            ),
          );
        }
      });
    });
  }

  /**
   * - iterates bindable elements (`containerId` | `startBinding.elementId` | `endBinding.elementId`) of the current element
   * - rebinds (mutates) each bindable element's `boundElements` to the current element
   * - returns mutated elements as affected elements
   */
  public static rebind = (
    element: OrderedExcalidrawElement,
    elements: SceneElementsMap,
    callback: (affectedElement: OrderedExcalidrawElement) => void,
  ) => {
    bindableElementsVisitor(element, elements, (bindableElement) => {
      let shouldRebindElement = true;

      boundElementsVisitor(bindableElement, elements, (boundElement) => {
        if (shouldRebindElement) {
          return;
        }

        if (boundElement.id === element.id) {
          // the element is already bound!
          shouldRebindElement = false;
        }
      });

      if (shouldRebindElement) {
        const boundElement = element as
          | ExcalidrawArrowElement
          | ExcalidrawTextElement;

        callback(
          mutateElement(
            bindableElement,
            {
              boundElements: newBoundElements(
                bindableElement.boundElements,
                new Set(),
                new Array(boundElement),
              ),
            },
            false,
          ),
        );
      }
    });
  };
}

export const fixBindingsAfterDeletion = (
  sceneElements: readonly ExcalidrawElement[],
  deletedElements: readonly ExcalidrawElement[],
): void => {
  const deletedElementIds = new Set(
    deletedElements.map((element) => element.id),
  );
  // non-deleted which bindings need to be updated
  const affectedElements: Set<ExcalidrawElement["id"]> = new Set();
  deletedElements.forEach((deletedElement) => {
    if (isBindableElement(deletedElement)) {
      deletedElement.boundElements?.forEach((element) => {
        if (!deletedElementIds.has(element.id)) {
          affectedElements.add(element.id);
        }
      });
    } else if (isBindingElement(deletedElement)) {
      if (deletedElement.startBinding) {
        affectedElements.add(deletedElement.startBinding.elementId);
      }
      if (deletedElement.endBinding) {
        affectedElements.add(deletedElement.endBinding.elementId);
      }
    }
  });

  sceneElements
    .filter(({ id }) => affectedElements.has(id))
    .forEach((element) => {
      if (isBindableElement(element)) {
        mutateElement(element, {
          boundElements: newBoundElements(
            element.boundElements,
            deletedElementIds,
          ),
        });
      } else if (isBindingElement(element)) {
        mutateElement(element, {
          startBinding: newBindingAfterDeletion(
            element.startBinding,
            deletedElementIds,
          ),
          endBinding: newBindingAfterDeletion(
            element.endBinding,
            deletedElementIds,
          ),
        });
      }
    });
};

const newBindingAfterDeletion = (
  binding: PointBinding | null,
  deletedElementIds: Set<ExcalidrawElement["id"]>,
): PointBinding | null => {
  if (binding == null || deletedElementIds.has(binding.elementId)) {
    return null;
  }
  return binding;
};

const newBoundElements = (
  boundElements: ExcalidrawElement["boundElements"],
  idsToRemove: Set<ExcalidrawElement["id"]>,
  elementsToAdd: Array<ExcalidrawArrowElement | ExcalidrawTextElement> = [],
) => {
  if (!boundElements) {
    return null;
  }

  const nextBoundElements = boundElements.filter(
    (ele) => !idsToRemove.has(ele.id),
  );

  nextBoundElements.push(
    ...elementsToAdd.map((x) => ({ id: x.id, type: x.type })),
  );

  return nextBoundElements;
};
