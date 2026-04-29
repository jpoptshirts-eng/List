# AI Shopping List Prototype

Responsive front-end prototype for a premium grocery “Shopping Lists” experience that converts rough intent into an editable, purchasable basket.

## Run locally

```bash
npm install
npm run dev
```

## How the experience works

1. **Entry screen**  
   Customer can type/paste a list, optionally upload a handwritten image, and optionally add a meal intent.
2. **Processing state**  
   Friendly progress messaging simulates parsing and interpretation.
3. **Draft digital basket**  
   Suggested products are grouped by shopping mission and shown as editable rows.
4. **Refinement**  
   Customer can change quantity, swap candidates, remove items, and add missed items.
5. **Review and add to basket**  
   Sticky summary shows item count and estimated total before adding all.
6. **Success state**  
   Confirms add-to-basket with next actions.

## Ambiguous item handling

The interpreter does not just echo terms. It maps rough inputs (for example `milk`, `toms`, `pasta`) to candidate products from a mock catalog.

- **High confidence**: one strong match is preselected
- **Medium confidence**: 2-3 likely options are shown, flagged for review
- **Low confidence**: no strong default, user is prompted to clarify via swap/manual edit

## Confidence model

Confidence is currently inferred from candidate count:

- `high`: <= 1 candidate
- `medium`: 2-3 candidates
- `low`: > 3 candidates or weak match quality

Rows with medium/low confidence are visually marked as “needs review”.

## New vs returning customer logic

- **New customer mode**: prioritizes bestsellers/popularity defaults
- **Returning customer mode**: prioritizes mock previous purchase tendencies (for example oat milk or seeded loaf)

This behavior is simulated in `src/lib/interpreter.ts` using separate default maps plus popularity fallback.

## Meal mode and quantity logic

Meal input (for example `spaghetti bolognese for 4`) generates a base ingredient set and scales quantities by servings.

Quantity starts with sensible defaults and can be adjusted inline for every row.

## Accessibility notes

- Semantic form labels for inputs
- Keyboard-operable controls
- Visible focus rings on interactive controls
- ARIA live region for processing state
- Status/error messages surfaced in readable text
