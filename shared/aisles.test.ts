import { describe, expect, it } from 'vitest';
import { guessAisle } from './aisles.ts';
import { GROCERY_AISLES } from './templates.ts';

describe('guessing aisles', () => {
  const guess = (name: string) => guessAisle(name, GROCERY_AISLES);

  it('reads the whole name first, then what it ends with, then each word from the last', () => {
    expect(guess('Peanut butter')).toBe('Pantry');
    expect(guess('Oat milk')).toBe('Dairy & eggs');
    expect(guess('Chicken broth')).toBe('Pantry');
    expect(guess('Chicken thighs')).toBe('Meat & seafood');
    expect(guess('Ice cream')).toBe('Frozen');
    expect(guess('Sour cream')).toBe('Dairy & eggs');
    expect(guess('Frozen peas')).toBe('Frozen');
    expect(guess('Orange juice')).toBe('Drinks');
    expect(guess('Dish soap')).toBe('Household');
    expect(guess('Green beans')).toBe('Produce');
    expect(guess('Black beans')).toBe('Pantry');
  });

  it('knows plurals and leaves what it doesn\'t know alone', () => {
    expect(guess('Lemons')).toBe('Produce');
    expect(guess('Tomatoes')).toBe('Produce');
    expect(guess('Blueberries')).toBe('Produce');
    expect(guess('Eggs')).toBe('Dairy & eggs');
    expect(guess('2 lbs ground beef')).toBe('Meat & seafood');
    expect(guess('Widgets')).toBeNull();
    expect(guess('')).toBeNull();
  });

  it("only picks from the list's own sections", () => {
    expect(guessAisle('Milk', ['Fruit & veg', 'Fridge'])).toBeNull();
    expect(guessAisle('Milk', ['produce', 'dairy & EGGS'])).toBe('dairy & EGGS');
  });
});
