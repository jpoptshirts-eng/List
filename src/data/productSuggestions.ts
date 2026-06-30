import type { ProductSuggestion } from '../lib/inputExperience'

/** Demo favourites — ranked first in autocomplete. */
export const MOCK_FAVOURITES: ProductSuggestion[] = [
  {
    id: 'fav-organic-milk-4pt',
    title: 'Duchy Organic Semi-Skimmed Milk',
    size: '4 pints',
    image: '🥛',
    price: 2.85,
    unitPrice: '71p/litre',
    source: 'favourite',
  },
  {
    id: 'fav-weetabix',
    title: 'Weetabix Cereal',
    size: '24 pack',
    image: '🥣',
    price: 3.5,
    unitPrice: '15p each',
    source: 'favourite',
  },
  {
    id: 'fav-butter',
    title: 'Essential Salted Butter',
    size: '250g',
    image: '🧈',
    price: 2.25,
    unitPrice: '£9.00/kg',
    source: 'favourite',
  },
  {
    id: 'fav-tea',
    title: 'Twinings Everyday Tea Bags',
    size: '80 pack',
    image: '🫖',
    price: 3.75,
    unitPrice: '5p each',
    source: 'favourite',
  },
  {
    id: 'fav-coffee',
    title: 'Waitrose No.1 Colombian Ground Coffee',
    size: '227g',
    image: '☕',
    price: 4.5,
    unitPrice: '£19.82/kg',
    source: 'favourite',
  },
]

/** Demo previous purchases — ranked second. */
export const MOCK_PREVIOUS_PURCHASES: ProductSuggestion[] = [
  {
    id: 'prev-organic-milk-1pt',
    title: 'Duchy Organic Semi-Skimmed Milk',
    size: '1 pint',
    image: '🥛',
    price: 1.15,
    unitPrice: '£1.15/pint',
    source: 'previous-purchase',
  },
  {
    id: 'prev-organic-whole-4pt',
    title: 'Duchy Organic Unhomogenised Whole Milk',
    size: '4 pints',
    image: '🥛',
    price: 3.1,
    unitPrice: '77p/litre',
    source: 'previous-purchase',
  },
  {
    id: 'prev-no1-ayrshire',
    title: 'No.1 Organic Unhomogenised Ayrshire Whole Milk',
    size: '1 litre',
    image: '🥛',
    price: 1.85,
    unitPrice: '£1.85/litre',
    source: 'previous-purchase',
  },
  {
    id: 'prev-oat-drink',
    title: 'Organic Oat Drink',
    size: '1 litre',
    image: '🌾',
    price: 1.95,
    unitPrice: '£1.95/litre',
    source: 'previous-purchase',
  },
  {
    id: 'prev-hovis',
    title: 'Hovis Soft White Medium Bread',
    size: '800g',
    image: '🍞',
    price: 1.4,
    unitPrice: '£1.75/kg',
    source: 'previous-purchase',
  },
  {
    id: 'prev-tea',
    title: 'PG Tips Tea Bags',
    size: '80 pack',
    image: '🫖',
    price: 3.25,
    unitPrice: '4p each',
    source: 'previous-purchase',
  },
  {
    id: 'prev-coffee',
    title: 'Nescafé Original Instant Coffee',
    size: '200g',
    image: '☕',
    price: 5.5,
    unitPrice: '£27.50/kg',
    source: 'previous-purchase',
  },
]

/** Wider catalogue — ranked third. */
export const MOCK_CATALOGUE: ProductSuggestion[] = [
  {
    id: 'cat-semi-2l',
    title: 'Essential Semi-Skimmed Milk',
    size: '2 litres',
    image: '🥛',
    price: 1.45,
    unitPrice: '73p/litre',
    source: 'catalogue',
  },
  {
    id: 'cat-whole-2l',
    title: 'Essential Whole Milk',
    size: '2 litres',
    image: '🥛',
    price: 1.45,
    unitPrice: '73p/litre',
    source: 'catalogue',
  },
  {
    id: 'cat-cheddar',
    title: 'Essential Mature Cheddar',
    size: '400g',
    image: '🧀',
    price: 3.25,
    unitPrice: '£8.13/kg',
    source: 'catalogue',
  },
  {
    id: 'cat-crisps',
    title: 'Walkers Ready Salted Crisps',
    size: '6 x 25g',
    image: '🥔',
    price: 2.0,
    unitPrice: '33p/pack',
    source: 'catalogue',
  },
  {
    id: 'cat-crisps-multipack',
    title: 'McCoy\'s Ridge Cut Cheddar & Onion Crisps',
    size: '6 x 25g',
    image: '🥔',
    price: 2.5,
    unitPrice: '42p/pack',
    source: 'catalogue',
  },
  {
    id: 'cat-bread-sourdough',
    title: 'No.1 Sourdough Bloomer',
    size: '400g',
    image: '🍞',
    price: 2.75,
    unitPrice: '£6.88/kg',
    source: 'catalogue',
  },
  {
    id: 'cat-cornflakes',
    title: 'Kellogg\'s Corn Flakes',
    size: '500g',
    image: '🥣',
    price: 3.0,
    unitPrice: '£6.00/kg',
    source: 'catalogue',
  },
  {
    id: 'cat-orange-juice',
    title: 'Essential Orange Juice',
    size: '1 litre',
    image: '🍊',
    price: 1.1,
    unitPrice: '£1.10/litre',
    source: 'catalogue',
  },
]

export const ALL_MOCK_SUGGESTIONS: ProductSuggestion[] = [
  ...MOCK_FAVOURITES,
  ...MOCK_PREVIOUS_PURCHASES,
  ...MOCK_CATALOGUE,
]

/** Demo OCR output when no live OCR service is available. */
export const MOCK_OCR_LIST_TEXT = `Milk
Bread
Juice
Spag bol
Butter
Sunday roast`
