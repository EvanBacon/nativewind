import { Block, CssNode, Declaration, walk } from "css-tree";
import { TextProps, TextStyle } from "react-native";
import { Atom, AtomStyle, StyleWithFunction } from "../style-sheet";
import { validProperties } from "./valid-styles";

export type StylesAndTopics = Required<Pick<Atom, "styles" | "topics">>;

export function getDeclarations(block: Block) {
  const atom: StylesAndTopics = {
    styles: [],
    topics: [],
  };

  walk(block, {
    visit: "Declaration",
    enter(node) {
      processDeclaration(atom, node);
    },
  });

  return {
    styles: flattenStyles(atom.styles),
    topics: atom.topics,
  };
}

function processDeclaration(atom: StylesAndTopics, node: Declaration) {
  switch (node.property) {
    case "border":
      return border(atom, node);
    case "box-shadow":
      return boxShadow(atom, node);
    case "flex":
      return flex(atom, node);
    case "flexFlow":
      return flexFlow(atom, node);
    case "font":
      return font(atom, node);
    case "fontFamily":
      return fontFamily(atom, node);
    default:
      pushStyleNode(atom, node.property, node);
  }
}

function pushStyle(
  atom: StylesAndTopics,
  property: string,
  node?: string | number | string[] | StyleWithFunction | CssNode | null
) {
  if (!node) return;

  const value = parseStyleValue(atom, node);

  if (value === undefined || value === null) return;

  const styleProperty = camelize(property);

  if (validProperties.has(styleProperty)) {
    atom.styles.push({
      [camelize(property)]: value,
    });
  }
}

function pushStyleNode(
  atom: StylesAndTopics,
  property: string,
  node?: CssNode | null
) {
  if (!node || node.type !== "Declaration" || node.value.type !== "Value") {
    return;
  }

  pushStyle(atom, property, node.value.children.shift()?.data);
}

function parseStyleValue(
  atom: StylesAndTopics,
  node?: string | number | string[] | StyleWithFunction | CssNode | null
): StyleWithFunction | string | number | string[] | undefined {
  if (!node) return;

  if (typeof node === "string") {
    return node;
  }

  if (typeof node === "number") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((n) => parseStyleValue(atom, n)) as string[];
  }

  if ("function" in node) {
    return node;
  }

  switch (node?.type) {
    case "Identifier":
      return node.name;
    case "Number":
      return Number.parseFloat(node.value);
    case "String":
      return node.value;
    case "Hash":
      return `#${node.value}`;
    case "Percentage":
      return `${node.value}%`;
    case "Dimension":
      switch (node.unit) {
        case "px":
          return Number.parseFloat(node.value);
        case "vw":
        case "vh":
          return {
            function: node.unit,
            values: [Number.parseFloat(node.value)],
          };
        default:
          return `${node.value}${node.unit}`;
      }
    case "Function":
      switch (node.name) {
        case "pixelRatio":
          return { function: "pixelRatio", values: [] };
        case "var": {
          const value = parseStyleValue(atom, node.children.shift()?.data);

          if (typeof value !== "string") return;

          atom.topics ??= [];
          atom.topics.push(value);

          return {
            function: "var",
            values: [value],
          };
        }
        default: {
          const values = node.children.toArray().flatMap((child) => {
            return parseStyleValue(atom, child) ?? [];
          });

          const hasDynamicValues = values.some(
            (value) => typeof value === "object"
          );

          return hasDynamicValues
            ? {
                function: "inbuilt",
                values: [node.name, ...values],
              }
            : `${node.name}(${values.join(", ")})`;
        }
      }
  }
}

function camelize(string: string) {
  return string.replace(/-./g, (x) => x[1].toUpperCase());
}

function flattenStyles(styles: AtomStyle[]): AtomStyle {
  let atomStyle: AtomStyle = {};

  for (const style of styles) {
    for (const [key, value] of Object.entries(style)) {
      atomStyle = setValue(atomStyle, key, value);
    }
  }

  return atomStyle;
}

function setValue<T extends Record<string, unknown>>(
  object: T,
  is: string | string[],
  value: unknown
): T {
  if (typeof is == "string") {
    return setValue<T>(object, is.split("."), value);
  } else if (is.length == 1) {
    (object as Record<string, unknown>)[is[0]] = value;
    return object;
  } else {
    (object as Record<string, unknown>)[is[0]] = setValue<T>(
      (object[is[0]] || {}) as T,
      is.slice(1),
      value
    );
    return object;
  }
}

function border(atom: StylesAndTopics, node: Declaration) {
  if (node.value.type !== "Value") {
    return;
  }

  const size = node.value.children.getSize();

  if (size === 1) {
    pushStyleNode(atom, "borderStyle", node.value.children.shift()?.data);
  }

  // TODO, this can be either
  // width | style
  // style | color
  if (size === 2) {
    pushStyleNode(atom, "borderWidth", node.value.children.shift()?.data);
    pushStyleNode(atom, "borderStyle", node.value.children.shift()?.data);
  }

  if (size === 3) {
    pushStyleNode(atom, "borderWidth", node.value.children.shift()?.data);
    pushStyleNode(atom, "borderStyle", node.value.children.shift()?.data);
    pushStyleNode(atom, "borderColor", node.value.children.shift()?.data);
  }
}

function boxShadow(atom: StylesAndTopics, node: Declaration) {
  if (node.value.type !== "Value") {
    return;
  }

  let children = node.value.children.toArray();
  const operatorIndex = children.findIndex(
    (child) => child.type === "Operator"
  );

  if (operatorIndex > 0) {
    children = children.slice(operatorIndex);
  }

  /* Keyword values */
  if (children.length === 1) {
    const child = node.value.children.shift()?.data;

    switch (child?.type) {
      case "Identifier":
        if (child.name === "none") {
          pushStyle(atom, "borderStyle", "none");
        }
        break;
      default:
        pushStyleNode(atom, "borderStyle", node.value.children.shift()?.data);
    }
  }

  /* offset-x | offset-y | color */
  if (children.length === 3) {
    pushStyleNode(atom, "shadowOffset.width", children[0]);
    pushStyleNode(atom, "shadowOffset.height", children[1]);
    pushStyleNode(atom, "shadowColor", children[2]);
  }

  if (children.length === 4) {
    /* inset | offset-x | offset-y | color */
    if (children[0].type === "Identifier" && children[0].name === "inset") {
      return;
    }

    /* offset-x | offset-y | blur-radius | color */
    pushStyle(atom, "shadowOffset.width", children[0]);
    pushStyle(atom, "shadowOffset.height", children[1]);
    pushStyle(atom, "shadowRadius", children[2]);
    pushStyle(atom, "shadowColor", children[3]);
  }

  // /* offset-x | offset-y | blur-radius | spread-radius | color */
  if (children.length === 5) {
    pushStyle(atom, "shadowOffset.width", children[0]);
    pushStyle(atom, "shadowOffset.height", children[1]);
    pushStyle(atom, "shadowRadius", children[3]);
    pushStyle(atom, "shadowColor", children[4]);
  }
}

function flex(atom: StylesAndTopics, node: Declaration) {
  if (node.value.type !== "Value") {
    return;
  }

  const children = node.value.children.toArray();

  if (children.length === 1) {
    const firstChild = children[0];

    if (firstChild.type === "Identifier") {
      /* Keyword values */
      if (firstChild.name === "none") {
        pushStyle(atom, "flexGrow", 0);
        pushStyle(atom, "flexShrink", 0);
        pushStyle(atom, "flexBasis", "auto");
      } else if (firstChild.name === "auto" || firstChild.name === "initial") {
        pushStyle(atom, "flexGrow", 1);
        pushStyle(atom, "flexShrink", 1);
        pushStyle(atom, "flexBasis", "auto");
      } else {
        return;
      }
    } else if (firstChild.type === "Number") {
      /* One value, unit-less number: flex-grow */
      pushStyle(atom, "flexGrow", children[0]);
    } else {
      pushStyle(atom, "flexBasis", children[0]);
    }
  }

  if (children.length === 2) {
    const secondChild = children[1];

    if (secondChild.type === "Number") {
      /* flex-grow | flex-shrink */
      pushStyle(atom, "flexGrow", children[0]);
      pushStyle(atom, "flexShrink", children[1]);
    } else {
      /* flex-grow | flex-basis */
      pushStyle(atom, "flexGrow", children[0]);
      pushStyle(atom, "flexBasis", children[1]);
    }
  }

  /* flex-grow | flex-shrink | flex-basis */
  if (children.length === 3) {
    pushStyle(atom, "flexGrow", children[0]);
    pushStyle(atom, "flexShrink", children[1]);
    pushStyle(atom, "flexBasis", children[2]);
  }
}

function flexFlow(atom: StylesAndTopics, node: Declaration) {
  if (node.value.type !== "Value") {
    return;
  }

  const children = node.value.children.toArray();

  if (children.length === 1) {
    const firstChild = children[0];

    if (firstChild.type === "Identifier") {
      if (
        firstChild.name === "row" ||
        firstChild.name === "column" ||
        firstChild.name === "row-reverse" ||
        firstChild.name === "column-reverse"
      ) {
        pushStyle(atom, "flexDirection", children[0]);
      } else if (
        firstChild.name === "wrap" ||
        firstChild.name === "nowrap" ||
        firstChild.name === "wrap-reverse"
      ) {
        pushStyle(atom, "flexWrap", children[0]);
      }
    }
  } else if (children.length === 2) {
    pushStyle(atom, "flexDirection", children[0]);
    pushStyle(atom, "flexWrap", children[1]);
  }
}

function font(atom: StylesAndTopics, node: Declaration) {
  if (node.value.type !== "Value") {
    return;
  }

  const children = node.value.children.toArray();

  let fontStyle;
  let fontVariant: string[] | undefined;
  let fontWeight: string | number | undefined;
  let fontStretch: string | undefined;
  let fontSize: number | undefined;

  for (const child of children) {
    if (!fontStyle) {
      if (child.type === "Identifier") {
        fontStyle = child.name;
        continue;
      } else {
        fontStyle = "normal";
      }
    }

    if (!fontVariant) {
      if (child.type === "Identifier" && child.name === "small-caps") {
        fontVariant = ["small-caps"];
        continue;
      } else {
        fontVariant = [];
      }
    }

    if (!fontWeight) {
      if (child.type === "Number") {
        fontWeight = child.value;
        continue;
      } else if (child.type === "Identifier" && child.name === "bold") {
        fontWeight = child.name;
        continue;
      }
    }

    if (!fontStretch && child.type === "Identifier") {
      fontStretch = "normal";
      continue;
    }

    if (!fontSize && child.type === "Number") {
      fontSize = Number.parseInt(child.value);
      continue;
    }
  }

  if (fontStyle !== "normal") pushStyle(atom, "fontStyle", fontStyle);
  if (fontVariant && fontVariant?.length > 0) {
    pushStyle(atom, "fontVariant", fontVariant);
  }
}

function fontFamily(atom: StylesAndTopics, node: Declaration) {
  if (node.value.type !== "Value") {
    return;
  }

  const children = node.value.children.toArray();
  const firstChild = children[0];

  if (firstChild.type === "Identifier") {
    pushStyle(atom, "fontFamily", firstChild.name);
  } else if (firstChild.type === "String") {
    pushStyle(atom, "fontFamily", firstChild.value);
  }
}
