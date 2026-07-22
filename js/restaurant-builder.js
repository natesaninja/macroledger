/**
 * Restaurant meal builders — pick components, totals update live.
 * Nutrition is approximate (matches common published values).
 */

function item(name, calories, protein, carbs, fat, fiber = 0, sodium = 0, sugar = 0) {
  return { name, calories, protein, carbs, fat, fiber, sodium_mg: sodium, sugar_g: sugar };
}

export const RESTAURANT_BUILDERS = [
  {
    id: "chipotle",
    name: "Chipotle",
    blurb: "Build a burrito, bowl, or tacos",
    formats: [
      { id: "bowl", label: "Bowl", tortilla: false },
      { id: "burrito", label: "Burrito", tortilla: true },
      { id: "tacos", label: "3 tacos", tortilla: false, note: "Tortillas estimated" },
    ],
    groups: [
      {
        id: "protein",
        label: "Protein",
        multi: false,
        required: true,
        options: [
          item("Chicken", 180, 32, 0, 7, 0, 310),
          item("Steak", 150, 21, 1, 6, 0, 330),
          item("Carnitas", 210, 23, 0, 12, 0, 430),
          item("Barbacoa", 170, 24, 2, 7, 0, 530),
          item("Sofritas", 150, 8, 9, 10, 3, 560),
          item("Veggie (no protein)", 0, 0, 0, 0),
        ],
      },
      {
        id: "rice",
        label: "Rice",
        multi: false,
        options: [
          item("None", 0, 0, 0, 0),
          item("White rice", 210, 4, 40, 4, 1, 350),
          item("Brown rice", 210, 5, 36, 6, 3, 180),
          item("Half white / half brown", 210, 4.5, 38, 5, 2, 265),
        ],
      },
      {
        id: "beans",
        label: "Beans",
        multi: true,
        options: [
          item("Black beans", 130, 8, 22, 1.5, 8, 280),
          item("Pinto beans", 130, 8, 21, 1.5, 8, 300),
        ],
      },
      {
        id: "salsa",
        label: "Salsa / toppings",
        multi: true,
        options: [
          item("Fresh tomato salsa", 25, 0, 4, 0, 1, 550),
          item("Roasted chili-corn", 80, 3, 16, 1.5, 3, 160),
          item("Tomatillo green", 15, 0, 4, 0, 1, 260),
          item("Tomatillo red", 30, 0, 4, 2, 0, 500),
          item("Sour cream", 110, 2, 2, 9, 0, 30),
          item("Fajita veggies", 20, 1, 4, 0, 1, 160),
          item("Cheese", 110, 6, 1, 8, 0, 190),
          item("Guacamole", 230, 3, 8, 22, 6, 370),
          item("Queso blanco", 120, 5, 4, 9, 0, 430),
          item("Lettuce", 5, 0, 1, 0, 0, 0),
        ],
      },
      {
        id: "tortilla",
        label: "Tortilla (burrito)",
        multi: false,
        options: [
          item("Flour tortilla", 320, 8, 50, 9, 3, 660),
          item("No tortilla", 0, 0, 0, 0),
        ],
      },
      {
        id: "sides",
        label: "Sides",
        multi: true,
        options: [
          item("Chips", 540, 7, 68, 26, 8, 390),
          item("Chips & guac", 770, 10, 76, 48, 14, 760),
          item("Chips & queso", 780, 14, 77, 46, 8, 1200),
        ],
      },
    ],
  },
  {
    id: "cfa",
    name: "Chick-fil-A",
    blurb: "Sandwich + sides + sauce",
    formats: [{ id: "meal", label: "Build a meal", tortilla: false }],
    groups: [
      {
        id: "entree",
        label: "Entree",
        multi: false,
        required: true,
        options: [
          item("Chicken Sandwich", 440, 29, 41, 19, 1, 1400, 6),
          item("Deluxe Sandwich", 500, 32, 43, 23, 2, 1520, 7),
          item("Spicy Sandwich", 460, 29, 45, 20, 1, 1450, 6),
          item("Grilled Sandwich", 390, 37, 44, 9, 3, 990, 11),
          item("Nuggets 8-count", 250, 27, 11, 11, 0, 980, 1),
          item("Nuggets 12-count", 380, 41, 16, 17, 1, 1470, 1),
          item("Grilled Nuggets 8", 130, 25, 1, 3, 0, 440, 1),
          item("Grilled Nuggets 12", 200, 38, 2, 4.5, 0, 660, 1),
        ],
      },
      {
        id: "side",
        label: "Side",
        multi: false,
        options: [
          item("No side", 0, 0, 0, 0),
          item("Waffle Fries (medium)", 420, 5, 45, 24, 5, 240, 0),
          item("Waffle Fries (small)", 320, 4, 35, 18, 4, 180, 0),
          item("Side Salad (no dressing)", 80, 6, 6, 4.5, 2, 180, 2),
          item("Fruit Cup", 60, 0, 14, 0, 2, 0, 12),
          item("Mac & Cheese (small)", 270, 12, 20, 16, 1, 720, 2),
        ],
      },
      {
        id: "sauce",
        label: "Sauces",
        multi: true,
        options: [
          item("CFA Sauce", 140, 0, 6, 13, 0, 170, 5),
          item("Polynesian", 110, 0, 21, 2.5, 0, 150, 20),
          item("Garden Herb Ranch", 140, 0, 1, 15, 0, 180, 1),
          item("Honey Mustard", 50, 0, 11, 0, 0, 100, 10),
          item("BBQ", 45, 0, 11, 0, 0, 130, 10),
          item("Buffalo", 30, 0, 1, 2.5, 0, 490, 0),
        ],
      },
      {
        id: "drink",
        label: "Drink",
        multi: false,
        options: [
          item("No drink", 0, 0, 0, 0),
          item("Lemonade medium", 230, 0, 60, 0, 0, 15, 57),
          item("Diet Lemonade medium", 60, 0, 16, 0, 0, 15, 14),
          item("Sweet Tea medium", 120, 0, 31, 0, 0, 10, 30),
          item("Unsweet Tea", 0, 0, 0, 0),
          item("Coke medium", 210, 0, 58, 0, 0, 45, 58),
        ],
      },
    ],
  },
  {
    id: "subway",
    name: "Subway",
    blurb: "Build a 6\" sub",
    formats: [
      { id: "six", label: '6-inch', mult: 1 },
      { id: "footlong", label: "Footlong", mult: 2 },
    ],
    groups: [
      {
        id: "protein",
        label: "Protein",
        multi: false,
        required: true,
        options: [
          item("Turkey Breast", 50, 11, 2, 1, 0, 480),
          item("Black Forest Ham", 60, 9, 3, 2, 0, 520),
          item("Oven Roasted Chicken", 80, 15, 3, 1.5, 0, 400),
          item("Italian B.M.T.", 180, 12, 4, 14, 0, 760),
          item("Meatballs", 260, 13, 18, 16, 2, 720, 6),
          item("Tuna", 240, 12, 2, 22, 0, 360, 0),
          item("Veggie Delite", 0, 0, 0, 0),
          item("Steak", 110, 14, 4, 4, 0, 420),
        ],
      },
      {
        id: "bread",
        label: "Bread (6\")",
        multi: false,
        options: [
          item("Italian / White", 200, 7, 38, 2, 2, 310, 3),
          item("9-Grain Wheat", 210, 8, 40, 2, 4, 280, 4),
          item("Hearty Multigrain", 210, 8, 39, 2.5, 4, 290, 4),
          item("Italian Herbs & Cheese", 240, 9, 41, 5, 2, 480, 3),
          item("Flatbread", 230, 8, 39, 5, 3, 500, 2),
        ],
      },
      {
        id: "cheese",
        label: "Cheese",
        multi: false,
        options: [
          item("No cheese", 0, 0, 0, 0),
          item("American", 40, 2, 1, 3.5, 0, 200),
          item("Provolone", 50, 4, 0, 4, 0, 150),
          item("Pepper Jack", 50, 3, 0, 4, 0, 160),
          item("Swiss", 50, 4, 0, 4, 0, 30),
        ],
      },
      {
        id: "veggies",
        label: "Veggies (free)",
        multi: true,
        options: [
          item("Lettuce / spinach / tomato / onion / peppers / cucumber / pickles", 15, 1, 3, 0, 1, 40, 2),
          item("Avocado", 60, 1, 3, 5, 2, 0, 0),
          item("Bacon", 80, 5, 0, 6, 0, 270, 0),
        ],
      },
      {
        id: "sauce",
        label: "Sauce",
        multi: true,
        options: [
          item("Mayo", 100, 0, 0, 11, 0, 80, 0),
          item("Ranch", 110, 0, 1, 12, 0, 180, 1),
          item("Sweet Onion", 80, 0, 18, 0, 0, 170, 16),
          item("Chipotle SW", 100, 0, 1, 10, 0, 150, 1),
          item("Mustard", 5, 0, 0, 0, 0, 60, 0),
          item("Oil & Vinegar", 45, 0, 0, 5, 0, 0, 0),
        ],
      },
    ],
  },
  {
    id: "tacobell",
    name: "Taco Bell",
    blurb: "Stack tacos & sides",
    formats: [{ id: "order", label: "Build order", tortilla: false }],
    groups: [
      {
        id: "mains",
        label: "Mains (pick several)",
        multi: true,
        required: true,
        options: [
          item("Crunchy Taco", 170, 8, 13, 9, 3, 310, 1),
          item("Soft Taco", 180, 9, 18, 8, 3, 500, 2),
          item("Doritos Locos Taco", 170, 8, 13, 10, 3, 350, 1),
          item("Crunchwrap Supreme", 530, 16, 71, 21, 5, 1200, 6),
          item("Cheesy Gordita Crunch", 500, 20, 41, 28, 5, 850, 4),
          item("Bean Burrito", 350, 13, 54, 9, 9, 1030, 3),
          item("Beefy 5-Layer", 490, 18, 50, 24, 6, 1250, 4),
          item("Chicken Quesadilla", 520, 27, 39, 28, 4, 1280, 3),
          item("Mexican Pizza", 540, 19, 48, 30, 7, 930, 4),
          item("Chalupa Supreme Beef", 350, 13, 30, 20, 3, 560, 3),
        ],
      },
      {
        id: "sides",
        label: "Sides / sweets",
        multi: true,
        options: [
          item("Chips & Nacho Cheese", 220, 4, 24, 12, 2, 330, 1),
          item("Cinnamon Twists", 170, 1, 26, 7, 1, 150, 10),
          item("Cinnabon Delights 2pc", 160, 2, 18, 9, 1, 90, 10),
          item("Baja Blast Freeze", 190, 0, 50, 0, 0, 55, 50),
          item("Medium soda", 200, 0, 54, 0, 0, 45, 54),
        ],
      },
    ],
  },
];

export function emptyTotals() {
  return { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium_mg: 0, sugar_g: 0 };
}

export function addItemToTotals(t, item, mult = 1) {
  t.calories += (item.calories || 0) * mult;
  t.protein += (item.protein || 0) * mult;
  t.carbs += (item.carbs || 0) * mult;
  t.fat += (item.fat || 0) * mult;
  t.fiber += (item.fiber || 0) * mult;
  t.sodium_mg += (item.sodium_mg || 0) * mult;
  t.sugar_g += (item.sugar_g || 0) * mult;
  return t;
}

export function sumSelection(builder, selected, format) {
  const t = emptyTotals();
  let mult = format?.mult || 1;
  // Chipotle burrito adds tortilla group; formats with tortilla flag
  for (const g of builder.groups) {
    const sel = selected[g.id];
    if (!sel) continue;
    const names = Array.isArray(sel) ? sel : [sel];
    for (const n of names) {
      const opt = g.options.find((o) => o.name === n);
      if (opt) addItemToTotals(t, opt, mult);
    }
  }
  // round
  for (const k of Object.keys(t)) t[k] = Math.round(t[k] * 10) / 10;
  return t;
}

export function selectionToLines(builder, selected, format) {
  const lines = [];
  const mult = format?.mult || 1;
  for (const g of builder.groups) {
    const sel = selected[g.id];
    if (!sel) continue;
    const names = Array.isArray(sel) ? sel : [sel];
    for (const n of names) {
      const opt = g.options.find((o) => o.name === n);
      if (!opt || (opt.calories === 0 && opt.protein === 0 && n.toLowerCase().includes("none"))) continue;
      if (n === "None" || n === "No side" || n === "No drink" || n === "No cheese" || n === "No tortilla") continue;
      lines.push({
        food_name: `${builder.name}: ${n}`,
        serving_size: mult > 1 ? `${format.label}` : "1 serving",
        servings: mult > 1 ? 1 : 1,
        calories: Math.round(opt.calories * mult),
        protein: Math.round(opt.protein * mult * 10) / 10,
        carbs: Math.round(opt.carbs * mult * 10) / 10,
        fat: Math.round(opt.fat * mult * 10) / 10,
        fiber: Math.round((opt.fiber || 0) * mult * 10) / 10,
        sodium_mg: Math.round((opt.sodium_mg || 0) * mult),
        sugar_g: Math.round((opt.sugar_g || 0) * mult * 10) / 10,
      });
    }
  }
  return lines;
}
