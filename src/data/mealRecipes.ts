export type Cuisine = 'British' | 'Chinese' | 'Indian' | 'Italian' | 'Mexican'

export type RecipeIngredient = {
  /** Product intent (canonical). */
  name: string
  required: boolean
  synonyms?: string[]
}

export type MealRecipe = {
  id: string
  chipLabel: string
  fullName: string
  cuisine: Cuisine
  ingredients: RecipeIngredient[]
  /** Override when Waitrose slug differs from generated URL. */
  methodUrl?: string
}

function normalizeRecipeSlug(fullName: string): string {
  return fullName
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\u2019\u2018']/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
}

/** Waitrose online recipe method page for a recipe title. */
export function waitroseRecipeMethodUrl(fullName: string): string {
  return `https://www.waitrose.com/ecom/recipe/${normalizeRecipeSlug(fullName)}`
}

function recipeMethodUrl(recipe: MealRecipe): string {
  return recipe.methodUrl ?? waitroseRecipeMethodUrl(recipe.fullName)
}

function normalizeMealLine(value: string): string {
  return value
    .toLowerCase()
    // Normalize curly apostrophes and other apostrophe-like characters.
    .replace(/[\u2019\u2018]/g, "'")
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const MEAL_RECIPES: MealRecipe[] = [
  // ALL (subset shown when Cuisine=All)
  {
    id: 'spag-bol',
    chipLabel: 'Spag Bol',
    fullName: 'Slow Cooker Spaghetti Bolognese',
    cuisine: 'Italian',
    ingredients: [
      { name: 'spaghetti', required: true, synonyms: ['spaghetti pasta', 'dry spaghetti pasta'] },
      { name: 'beef mince', required: true, synonyms: ['minced beef'] },
      { name: 'chopped tomatoes', required: true, synonyms: ['tinned chopped tomatoes'] },
      { name: 'onion', required: true, synonyms: ['yellow onion'] },
      { name: 'garlic', required: true },
      { name: 'tomato puree', required: true, synonyms: ['tomato purée'] },
      { name: 'italian herbs', required: true, synonyms: ['mixed herbs'] },
      { name: 'parmesan', required: false, synonyms: ['Parmigiano Reggiano'] },
    ],
  },
  {
    id: 'chicken-tikka',
    chipLabel: 'Chicken Tikka',
    fullName: 'Chicken Tikka Masala',
    cuisine: 'Indian',
    ingredients: [
      { name: 'chicken', required: true, synonyms: ['chicken thighs', 'chicken pieces', 'boneless chicken thighs'] },
      { name: 'tikka masala cooking sauce', required: true, synonyms: ['tikka masala sauce'] },
      { name: 'double cream', required: true, synonyms: ['heavy cream'] },
      { name: 'ginger', required: true },
      { name: 'garlic', required: true },
      { name: 'lemon', required: false },
      { name: 'coriander', required: false },
    ],
  },
  {
    id: 'sesame-tofu',
    chipLabel: 'Sesame Tofu',
    fullName: 'Crispy Sesame Tofu & Mushroom Stir Fry',
    cuisine: 'Chinese',
    ingredients: [
      { name: 'tofu', required: true, synonyms: ['firm tofu'] },
      { name: 'sesame oil', required: true, synonyms: ['sesame oil'] },
      { name: 'soy sauce', required: true, synonyms: ['dark soy sauce'] },
      { name: 'mushrooms', required: true },
      { name: 'spring onion', required: true, synonyms: ['salad onions'] },
      { name: 'stir fry sauce', required: true, synonyms: ['stir-fry sauce'] },
      { name: 'black bean stir fry sauce', required: false, synonyms: ['black bean sauce'] },
    ],
  },
  {
    id: 'roast-chicken',
    chipLabel: 'Roast Chicken',
    fullName: 'Perfect Roast Chicken',
    cuisine: 'British',
    ingredients: [
      { name: 'whole chicken', required: true, synonyms: ['roast chicken'] },
      { name: 'lemons', required: true, synonyms: ['lemon'] },
      { name: 'garlic', required: true },
      { name: 'onion', required: true },
      { name: 'fresh herbs', required: true, synonyms: ['thyme', 'bay leaves'] },
      { name: 'black pepper', required: false },
    ],
  },
  {
    id: 'chicken-tacos',
    chipLabel: 'Chicken Tacos',
    fullName: 'Spiced Chicken & Sweetcorn Tacos',
    cuisine: 'Mexican',
    ingredients: [
      { name: 'chicken', required: true, synonyms: ['chicken strips', 'chicken breast'] },
      { name: 'taco shells', required: true, synonyms: ['soft tacos', 'tortillas'] },
      { name: 'salsa', required: true, synonyms: ['chopped tomatoes salsa'] },
      { name: 'onion', required: true },
      { name: 'lettuce', required: true, synonyms: ['leaf lettuce'] },
      { name: 'lime', required: false, synonyms: ['limes'] },
      { name: 'jalapeno', required: false, synonyms: ['jalapenos'] },
    ],
  },
  {
    id: 'chana-dal',
    chipLabel: 'Chana Dal',
    fullName: 'Creamy Chana Dal',
    cuisine: 'Indian',
    ingredients: [
      { name: 'chana dal', required: true, synonyms: ['split chickpeas', 'chick peas'] },
      { name: 'cumin seeds', required: true, synonyms: ['cumin'] },
      { name: 'onion', required: true },
      { name: 'garlic', required: true },
      { name: 'ginger', required: true },
      { name: 'ground turmeric', required: false, synonyms: ['turmeric'] },
      { name: 'coconut milk', required: false, synonyms: ['coconut cream'] },
    ],
  },

  // BRITISH
  {
    id: 'fish-chips',
    chipLabel: 'Fish & Chips',
    fullName: 'Fish & Chips with Tartar Sauce',
    cuisine: 'British',
    ingredients: [
      { name: 'fish fillets', required: true, synonyms: ['cod', 'haddock'] },
      { name: 'potatoes', required: true, synonyms: ['baking potatoes', 'chipping potatoes'] },
      { name: 'batter mix', required: true, synonyms: ['baking powder batter mix'] },
      { name: 'peas', required: false },
      { name: 'tartar sauce', required: false, synonyms: ['tartare sauce'] },
    ],
  },
  {
    id: 'shepherds-pie',
    chipLabel: 'Shepherd’s Pie',
    fullName: "Shepherd’s Pie",
    cuisine: 'British',
    ingredients: [
      { name: 'lamb mince', required: true, synonyms: ['minced lamb'] },
      { name: 'potatoes', required: true, synonyms: ['mashed potatoes'] },
      { name: 'onion', required: true },
      { name: 'carrots', required: true, synonyms: ['carrot'] },
      { name: 'peas', required: true, synonyms: ['frozen peas'] },
      { name: 'stock cubes', required: false, synonyms: ['lamb stock'] },
    ],
  },
  {
    id: 'cottage-pie',
    chipLabel: 'Cottage Pie',
    fullName: 'Classic Cottage Pie',
    cuisine: 'British',
    ingredients: [
      { name: 'beef mince', required: true, synonyms: ['minced beef'] },
      { name: 'potatoes', required: true, synonyms: ['mashed potatoes'] },
      { name: 'onion', required: true },
      { name: 'carrots', required: true },
      { name: 'peas', required: true },
      { name: 'stock cubes', required: false, synonyms: ['beef stock'] },
    ],
  },
  {
    id: 'vegan-cottage-pie',
    chipLabel: 'Vegan Cottage Pie',
    fullName: 'Vegan Cottage Pie',
    cuisine: 'British',
    ingredients: [
      { name: 'plant mince', required: true, synonyms: ['vegan mince'] },
      { name: 'potatoes', required: true, synonyms: ['mashed potatoes'] },
      { name: 'onion', required: true },
      { name: 'carrots', required: true },
      { name: 'peas', required: true },
      { name: 'cooking stock', required: false, synonyms: ['vegetable stock'] },
    ],
  },
  {
    id: 'roast-beef',
    chipLabel: 'Roast Beef',
    fullName: 'Roast Beef with Pink Peppercorns, Peas & Basil',
    cuisine: 'British',
    ingredients: [
      { name: 'roast beef', required: true, synonyms: ['beef joint'] },
      { name: 'pink peppercorns', required: true, synonyms: ['peppercorns'] },
      { name: 'peas', required: true },
      { name: 'basil', required: false },
    ],
  },

  // CHINESE
  {
    id: 'szechuan-chicken',
    chipLabel: 'Szechuan Chicken',
    fullName: 'Szechuan Chicken with Sesame Cucumbers',
    cuisine: 'Chinese',
    ingredients: [
      { name: 'chicken', required: true, synonyms: ['chicken thigh'] },
      { name: 'szechuan sauce', required: true, synonyms: ['Szechuan sauce'] },
      { name: 'sesame oil', required: false, synonyms: ['sesame seed oil'] },
      { name: 'cucumber', required: true, synonyms: ['cucumbers'] },
      { name: 'garlic', required: true },
      { name: 'ginger', required: false },
    ],
  },
  {
    id: 'five-spice-duck',
    chipLabel: 'Five-Spice Duck',
    fullName: 'Five-Spice Duck with Stir-Fried Cucumber & Cashews',
    cuisine: 'Chinese',
    ingredients: [
      { name: 'duck', required: true, synonyms: ['duck pieces'] },
      { name: 'five spice seasoning', required: true, synonyms: ['five-spice'] },
      { name: 'hoisin sauce', required: false, synonyms: ['chinese sauce'] },
      { name: 'cucumber', required: true },
      { name: 'cashews', required: false },
      { name: 'spring onion', required: false, synonyms: ['salad onions'] },
    ],
  },
  {
    id: 'prawn-noodles',
    chipLabel: 'Prawn Noodles',
    fullName: 'Rice Noodles with Prawns, Dark Soy Sauce & Sesame Fried Egg',
    cuisine: 'Chinese',
    ingredients: [
      { name: 'prawns', required: true },
      { name: 'rice noodles', required: true, synonyms: ['rice noodle'] },
      { name: 'dark soy sauce', required: true, synonyms: ['soy sauce'] },
      { name: 'sesame oil', required: false },
      { name: 'egg', required: false, synonyms: ['eggs'] },
      { name: 'spring onion', required: false, synonyms: ['salad onions'] },
    ],
  },

  // INDIAN
  {
    id: 'butter-chicken',
    chipLabel: 'Butter Chicken',
    fullName: 'Chicken Butter Masala',
    cuisine: 'Indian',
    ingredients: [
      { name: 'chicken', required: true, synonyms: ['chicken pieces'] },
      { name: 'butter masala cooking sauce', required: true, synonyms: ['butter masala sauce'] },
      { name: 'double cream', required: true },
      { name: 'garlic', required: true },
      { name: 'ginger', required: false },
      { name: 'onion', required: false },
    ],
  },
  {
    id: 'tandoori-lamb',
    chipLabel: 'Tandoori Lamb',
    fullName: 'Tandoori Lamb Chops',
    cuisine: 'Indian',
    ingredients: [
      { name: 'lamb', required: true, synonyms: ['lamb chops', 'lamb'] },
      { name: 'tandoori marinade', required: true, synonyms: ['tandoori marinade sauce'] },
      { name: 'lemon', required: false },
      { name: 'onion', required: false },
      { name: 'coriander', required: false },
    ],
  },
  {
    id: 'paneer-korma',
    chipLabel: 'Paneer Korma',
    fullName: 'Paneer Korma',
    cuisine: 'Indian',
    ingredients: [
      { name: 'paneer', required: true },
      { name: 'korma cooking sauce', required: true, synonyms: ['korma sauce'] },
      { name: 'peas', required: true, synonyms: ['frozen peas'] },
      { name: 'garlic', required: false },
      { name: 'ginger', required: false },
    ],
  },
  {
    id: 'sweet-potato-curry',
    chipLabel: 'Sweet Potato Curry',
    fullName: 'Sweet Potato & Pea Curry',
    cuisine: 'Indian',
    ingredients: [
      { name: 'sweet potatoes', required: true, synonyms: ['sweet potato'] },
      { name: 'curry sauce', required: true, synonyms: ['curry paste', 'curry'] },
      { name: 'peas', required: true, synonyms: ['frozen peas'] },
      { name: 'onion', required: true },
      { name: 'garlic', required: false },
      { name: 'ginger', required: false },
    ],
  },

  // ITALIAN
  {
    id: 'prawn-risotto',
    chipLabel: 'Prawn Risotto',
    fullName: 'Creamy Prawn Risotto',
    cuisine: 'Italian',
    ingredients: [
      { name: 'prawns', required: true },
      { name: 'arborio rice', required: true, synonyms: ['risotto rice'] },
      { name: 'stock', required: true, synonyms: ['chicken stock cube', 'vegetable stock'] },
      { name: 'parmesan', required: false, synonyms: ['Parmigiano Reggiano'] },
      { name: 'butter', required: false },
      { name: 'lemon', required: false },
    ],
  },
  {
    id: 'cauliflower-pasta',
    chipLabel: 'Cauliflower Pasta',
    fullName: 'Cauliflower Pasta with Caramelised Cauliflower, Anchovy & Pine Nuts',
    cuisine: 'Italian',
    ingredients: [
      { name: 'cauliflower', required: true },
      { name: 'pasta', required: true, synonyms: ['penne', 'rigatoni', 'pasta'] },
      { name: 'anchovies', required: true, synonyms: ['anchovy fillets'] },
      { name: 'pine nuts', required: false },
      { name: 'garlic', required: false },
      { name: 'parmesan', required: false, synonyms: ['Parmigiano Reggiano'] },
    ],
  },
  {
    id: 'veg-lasagne',
    chipLabel: 'Veg Lasagne',
    fullName: 'Mediterranean Grilled Vegetable Lasagne',
    cuisine: 'Italian',
    ingredients: [
      { name: 'lasagne sheets', required: true, synonyms: ['lasagne pasta'] },
      { name: 'vegetable mix', required: true, synonyms: ['grilled vegetable mix', 'vegetable mix'] },
      { name: 'tomato sauce', required: true, synonyms: ['marinara sauce'] },
      { name: 'cheese', required: true, synonyms: ['grated cheese', 'mature cheddar'] },
      { name: 'olive oil', required: false },
      { name: 'basil', required: false },
    ],
  },

  // MEXICAN
  {
    id: 'chicken-fajitas',
    chipLabel: 'Chicken Fajitas',
    fullName: 'Chipotle & Lime Roast Chicken with Quick Pickled Onions (Fajitas)',
    cuisine: 'Mexican',
    ingredients: [
      { name: 'chicken', required: true, synonyms: ['chicken strips'] },
      { name: 'fajita seasoning', required: true, synonyms: ['fajitas seasoning', 'fajita spice mix'] },
      { name: 'peppers', required: true, synonyms: ['bell pepper', 'sweet pepper', 'peppers mix'] },
      { name: 'onion', required: true },
      { name: 'tortillas', required: true, synonyms: ['fajita wraps'] },
      { name: 'lime', required: false },
    ],
  },
  {
    id: 'chipotle-chicken',
    chipLabel: 'Chipotle Chicken',
    fullName: 'Chipotle & Lime Roast Chicken with Quick Pickled Onions',
    cuisine: 'Mexican',
    ingredients: [
      { name: 'chicken', required: true, synonyms: ['whole chicken', 'chicken'] },
      { name: 'chipotle paste', required: true, synonyms: ['chipotle chilli paste'] },
      { name: 'lime', required: false, synonyms: ['limes'] },
      { name: 'onion', required: false },
      { name: 'sour cream', required: false, synonyms: ['creme fraiche'] },
      { name: 'garlic', required: false },
    ],
  },
]

export const MEAL_CHIP_ORDER_BY_CUISINE: Record<'All' | Cuisine, string[]> = {
  All: ['Spag Bol', 'Chicken Tikka', 'Sesame Tofu', 'Roast Chicken', 'Chicken Tacos', 'Chana Dal'],
  British: ['Fish & Chips', 'Shepherd’s Pie', 'Roast Chicken', 'Cottage Pie', 'Vegan Cottage Pie', 'Roast Beef'],
  Chinese: ['Szechuan Chicken', 'Sesame Tofu', 'Five-Spice Duck', 'Prawn Noodles'],
  Indian: ['Butter Chicken', 'Tandoori Lamb', 'Paneer Korma', 'Chicken Tikka', 'Chana Dal', 'Sweet Potato Curry'],
  Italian: ['Prawn Risotto', 'Cauliflower Pasta', 'Spag Bol', 'Veg Lasagne'],
  Mexican: ['Chicken Fajitas', 'Chipotle Chicken', 'Chicken Tacos'],
}

const recipeByChipLabel = new Map<string, MealRecipe>()
for (const r of MEAL_RECIPES) {
  recipeByChipLabel.set(normalizeMealLine(r.chipLabel), r)
}

export function findMealRecipeForLine(line: string): MealRecipe | null {
  const n = normalizeMealLine(line)
  return recipeByChipLabel.get(n) ?? null
}

/** Chip label for an active meal row (stored or inferred from title). */
export function chipLabelForMeal(meal: { title: string; chipLabel?: string }): string | null {
  if (meal.chipLabel) return meal.chipLabel
  const n = normalizeMealLine(meal.title)
  for (const recipe of MEAL_RECIPES) {
    if (normalizeMealLine(recipe.fullName) === n || normalizeMealLine(recipe.chipLabel) === n) {
      return recipe.chipLabel
    }
  }
  return null
}

/** Waitrose recipe method URL for an active meal row (stored or inferred from title). */
export function methodUrlForMeal(meal: { title: string; chipLabel?: string; methodUrl?: string }): string | null {
  if (meal.methodUrl) return meal.methodUrl
  const n = normalizeMealLine(meal.title)
  for (const recipe of MEAL_RECIPES) {
    if (
      normalizeMealLine(recipe.fullName) === n ||
      normalizeMealLine(recipe.chipLabel) === n ||
      (meal.chipLabel && normalizeMealLine(recipe.chipLabel) === normalizeMealLine(meal.chipLabel))
    ) {
      return recipeMethodUrl(recipe)
    }
  }
  return null
}

