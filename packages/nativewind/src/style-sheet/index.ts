import {
  Appearance,
  ColorSchemeName,
  Dimensions,
  EmitterSubscription,
  Platform,
  PlatformOSType,
  StyleSheet,
} from "react-native";
import { match } from "css-mediaquery";
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/shim/with-selector";

import { AtRuleTuple, Style } from "../types/common";
import themeFunctions from "./theme-functions";

type Listener<T> = (state: T, oldState: T) => void;

export type AtomStyle = {
  [T in keyof Style]: Style[T] | StyleWithUnits<T>;
};

type StyleWithUnits<T extends keyof Style> = {
  units: string[];
  value: Style[T] | string;
};

export interface Atom {
  styles: AtomStyle[];
  atRules?: Record<number, Array<AtRuleTuple>>;
  conditions?: string[];
  customProperties?: string[];
  topics?: string[];
  topicSubscription?: () => void;
  childClasses?: string[];
  transforms?: Record<string, true>;
  meta?: Record<string, true>;
}

const createSetter =
  <T extends Record<string, unknown | undefined>>(
    getRecord: () => T,
    setRecord: (newDate: T) => void,
    listeners: Set<Listener<T>>
  ) =>
  (partialRecord: T | ((value: T) => T)) => {
    const oldRecord = { ...getRecord() };
    setRecord(
      typeof partialRecord === "function"
        ? partialRecord(oldRecord)
        : partialRecord
    );

    for (const listener of listeners) listener(getRecord(), oldRecord);
  };

const createSubscriber =
  <T>(listeners: Set<Listener<T>>) =>
  (listener: Listener<T>) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

// eslint-disable-next-line unicorn/no-useless-undefined
let dimensionsListener: EmitterSubscription | undefined = undefined;

const atoms: Map<string, Atom> = new Map();
const childClasses: Map<string, string[]> = new Map();
const styleMeta: Map<string, Record<string, boolean>> = new Map();

let styleSets: Record<string, Style[]> = {};
const styleSetsListeners = new Set<Listener<typeof styleSets>>();
const setStyleSets = createSetter(
  () => styleSets,
  (data) => {
    styleSets = { ...styleSets, ...data };
  },
  styleSetsListeners
);
const subscribeToStyleSets = createSubscriber(styleSetsListeners);

let styles: Record<string, Style[] | undefined> = {};
const styleListeners = new Set<Listener<typeof styles>>();
const setStyles = createSetter(
  () => styles,
  (data) => {
    styles = { ...styles, ...data };
  },
  styleListeners
);
const subscribeToStyles = createSubscriber(styleListeners);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let topicValues: Record<string, string | number> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const topicValueListeners = new Set<Listener<typeof topicValues>>();
const setTopicValues = createSetter(
  () => topicValues,
  (data) => {
    topicValues = { ...topicValues, ...data };
  },
  topicValueListeners
);
const subscribeToTopics = createSubscriber(topicValueListeners);

let isPreprocessed = Platform.select({
  default: false,
  web: typeof StyleSheet.create({ test: {} }).test !== "number",
});

let dangerouslyCompileStyles: (css: string) => void | undefined;

export const NativeWindStyleSheet = {
  ...themeFunctions,
  create,
  warmCache,
  useSync,
  reset: () => {
    atoms.clear();
    childClasses.clear();
    styleSets = {};
    styleSetsListeners.clear();
    styles = {};
    styleListeners.clear();
    topicValues = {
      platform: Platform.OS,
    };
    topicValueListeners.clear();
    setDimensions(Dimensions);
    setColorScheme("system");

    // Add some default atoms. These no do not compile

    atoms.set("group", {
      styles: [],
      meta: {
        group: true,
      },
    });

    atoms.set("group-isolate", {
      styles: [],
      meta: {
        groupIsolate: true,
      },
    });

    atoms.set("parent", {
      styles: [],
      meta: {
        parent: true,
      },
    });
  },
  isPreprocessed: () => isPreprocessed,
  setOutput: (
    specifics: { [platform in PlatformOSType]?: "native" | "css" } & {
      default: "native" | "css";
    }
  ) => (isPreprocessed = Platform.select(specifics) === "css"),
  getColorScheme,
  setColorScheme,
  toggleColorScheme,
  setCustomProperties,
  setDimensions,
  setDangerouslyCompileStyles: (callback: typeof dangerouslyCompileStyles) =>
    (dangerouslyCompileStyles = callback),
};
NativeWindStyleSheet.reset();

export type CreateOptions = Record<string, Atom>;

function create(options: CreateOptions) {
  if (isPreprocessed) {
    return;
  }

  let newStyles: Record<string, Style[] | undefined> = {};

  for (const [atomName, atom] of Object.entries(options)) {
    if (atom.topics) {
      atom.topicSubscription = subscribeToTopics((values, oldValues) => {
        const topicChanged = atom.topics?.some((topic) => {
          return values[topic] !== oldValues[topic];
        });

        if (!topicChanged) {
          return;
        }

        setStyles(evaluate(atomName, atom));
      });
    }

    // Remove any existing subscriptions
    atoms.get(atomName)?.topicSubscription?.();
    atoms.set(atomName, atom);
    newStyles = { ...newStyles, ...evaluate(atomName, atom) };
  }

  setStyles(newStyles);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unitRecord: Record<string, (...options: any[]) => any> = {};

function evaluate(name: string, atom: Atom) {
  const atomStyles: Style[] = [];
  let newStyles: Record<string, Style[] | undefined> = {
    [name]: atomStyles,
  };

  for (const [index, originalStyles] of atom.styles.entries()) {
    const styles = { ...originalStyles } as Style;

    for (const [key, value] of Object.entries(originalStyles)) {
      let newValue = value;
      if (isStyleWithUnits(value)) {
        for (const unit of value.units) {
          newValue = unitRecord[unit](value);
        }
        (styles as Record<string, unknown>)[key] = newValue;
      }
    }

    const atRules = atom.atRules?.[index];

    if (!atRules || atRules.length === 0) {
      atomStyles.push(styles);
      continue;
    }

    const atRulesResult = atRules.every(([rule, params]) => {
      if (rule === "selector") {
        // These atRules shouldn't be on the atomic styles, they only
        // apply to childStyles
        return false;
      } else if (rule === "colorScheme") {
        return topicValues["colorScheme"] === params;
      } else {
        return matchAtRule({
          rule,
          params,
          width: topicValues["width"] as number,
          height: topicValues["height"] as number,
          orientation: topicValues["orientation"] as OrientationLockType,
        });
      }
    });

    if (atRulesResult) {
      // All atRules matches, so add the style
      atomStyles.push(styles);

      // If there are children also add them.
      if (atom.childClasses) {
        for (const child of atom.childClasses) {
          const childAtom = atoms.get(child);
          if (childAtom) {
            newStyles = { ...newStyles, ...evaluate(child, childAtom) };
          }
        }
      }
    } else {
      // If there are children also add them.
      if (atom.childClasses) {
        for (const child of atom.childClasses) {
          newStyles[child] = undefined;
        }
      }
    }
  }

  return newStyles;
}

function useSync(
  className: string,
  componentState: Record<string, boolean | number> = {}
) {
  const keyTokens: string[] = [];
  const conditions = new Set<string>();

  for (const atomName of className.split(/\s+/)) {
    const atom = atoms.get(atomName);

    if (!atom) continue;

    if (atom.conditions) {
      let conditionsPass = true;
      for (const condition of atom.conditions) {
        conditions.add(condition);

        if (conditionsPass) {
          switch (condition) {
            case "not-first-child":
              conditionsPass =
                typeof componentState["nthChild"] === "number" &&
                componentState["nthChild"] > 0;
              break;
            case "odd":
              conditionsPass =
                typeof componentState["nthChild"] === "number" &&
                componentState["nthChild"] % 2 === 1;
              break;
            case "even":
              conditionsPass =
                typeof componentState["nthChild"] === "number" &&
                componentState["nthChild"] % 2 === 0;
              break;
            default:
              conditionsPass = !!componentState[condition];
          }
        }
      }

      if (conditionsPass) {
        keyTokens.push(atomName);
      }
    } else {
      keyTokens.push(atomName);
    }
  }

  const key = keyTokens.join(" ");

  if (!styleSets[key] && key.length > 0) {
    warmCache([keyTokens]);
  }

  const currentStyles = useSyncExternalStoreWithSelector(
    subscribeToStyleSets,
    () => styleSets,
    () => styleSets,
    (styles) => styles[key]
  );

  return {
    styles: currentStyles,
    childClasses: childClasses.get(key),
    meta: styleMeta.get(key),
    conditions,
  };
}

function warmCache(tokenSets: Array<string[]>) {
  for (const keyTokens of tokenSets) {
    const key = keyTokens.join(" ");

    setStyleSets({
      [key]: keyTokens.flatMap((token) => {
        return styles[token] ?? [];
      }),
    });

    subscribeToStyles((styles, oldStyles) => {
      const hasChanged = keyTokens.some(
        (token) => styles[token] !== oldStyles[token]
      );

      if (hasChanged) {
        setStyleSets({
          [key]: keyTokens.flatMap((token) => styles[token] ?? []),
        });
      }
    });

    const children = keyTokens.flatMap((token) => {
      const childClasses = atoms.get(token)?.childClasses;
      return childClasses ?? [];
    });

    if (children.length > 0) {
      childClasses.set(key, children);
    }
  }
}

function getColorScheme() {
  return topicValues["colorScheme"] as "light" | "dark";
}

function setColorScheme(system?: ColorSchemeName | "system" | null) {
  setTopicValues({
    colorSchemeSystem: system ?? "system",
    colorScheme:
      !system || system === "system"
        ? Appearance.getColorScheme() || "light"
        : system,
  });
}

function setCustomProperties(
  properties: Record<`--${string}`, string | number>
) {
  setTopicValues(properties);
}

function toggleColorScheme() {
  return setTopicValues((state) => {
    const currentColor =
      state["colorSchemeSystem"] === "system"
        ? Appearance.getColorScheme() || "light"
        : state["colorScheme"];

    const newColor = currentColor === "light" ? "dark" : "light";

    return {
      colorScheme: newColor,
      colorSchemeSystem: newColor,
    };
  });
}

topicValueListeners.add((topics) => {
  if (typeof localStorage !== "undefined") {
    localStorage.nativewind_theme = topics["colorScheme"];
  }
});

try {
  if (typeof localStorage !== "undefined") {
    const isDarkMode = window.matchMedia(
      "(prefers-color-scheme: dark)"
    ).matches;

    const hasLocalStorageTheme = "nativewind_theme" in localStorage;

    if (
      localStorage.nativewind_theme === "dark" ||
      (!hasLocalStorageTheme && isDarkMode)
    ) {
      document.documentElement.classList.add("dark");
      setColorScheme("dark");
    } else {
      document.documentElement.classList.remove("dark");
      setColorScheme("light");
    }
  }
} catch {
  // Do nothing
}

Appearance.addChangeListener(({ colorScheme }) => {
  setColorScheme(colorScheme);
});

function setDimensions(dimensions: Dimensions) {
  dimensionsListener?.remove();

  const window = dimensions.get("window");
  setTopicValues({
    width: window.width,
    height: window.height,
    orientation: window.width > window.height ? "landscape" : "portrait",
  });

  dimensionsListener = dimensions.addEventListener("change", ({ window }) => {
    setTopicValues({
      width: window.width,
      height: window.height,
      orientation: window.width > window.height ? "landscape" : "portrait",
    });
  });
}

interface MatchAtRuleOptions {
  rule: string;
  params?: string;
  width: number;
  height: number;
  orientation: OrientationLockType;
}

function matchAtRule({
  rule,
  params,
  width,
  height,
  orientation,
}: MatchAtRuleOptions) {
  if (rule === "media" && params) {
    return match(params, {
      type: Platform.OS,
      "aspect-ratio": width / height,
      "device-aspect-ratio": width / height,
      width,
      height,
      "device-width": width,
      "device-height": width,
      orientation,
    });
  }

  return false;
}

function isStyleWithUnits<T extends keyof Style>(
  style: Style[T] | StyleWithUnits<T>
): style is StyleWithUnits<T> {
  return typeof style === "object" && "units" in style;
}
