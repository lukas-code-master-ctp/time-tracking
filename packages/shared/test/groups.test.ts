import { describe, expect, it } from 'vitest';
import { groupsOf, membersOf, readGroup, sortGroups, validateGroup } from '../src/groups.js';

// Spec 2026-11-13-grupos-y-comunicados-agendados.
const g = (id: string, name: string, memberUids: string[]) => ({ id, name, memberUids, createdAt: 1, createdBy: 'a', updatedAt: 1, updatedBy: 'a' });

describe('groups', () => {
  it('validates name and members', () => {
    expect(validateGroup({ name: 'Terreno', memberUids: ['x'] })).toEqual([]);
    expect(validateGroup({ name: ' ', memberUids: [] }).map((i) => i.path)).toEqual(['name', 'memberUids']);
    expect(validateGroup({ name: 'x'.repeat(61), memberUids: ['x'] })[0]?.path).toBe('name');
    expect(validateGroup({ name: ' terreno ', memberUids: ['x'] }, [{ name: 'Terreno' }])[0]?.message).toBe('Ya hay un grupo con ese nombre.');
  });

  it('reads valid documents only', () => {
    expect(readGroup(g('g', 'T', ['a']))).toMatchObject({ name: 'T', memberUids: ['a'] });
    expect(readGroup({ name: 'T', memberUids: [1] })).toBeNull();
    expect(readGroup(null)).toBeNull();
  });

  it('resolves members and memberships', () => {
    const groups = [g('g1', 'Terreno', ['a', 'b']), g('g2', 'Jefaturas', ['b', 'c'])];
    expect(membersOf(groups, ['g1', 'g2', 'nope'])).toEqual(['a', 'b', 'c']);
    expect(membersOf(groups, [])).toEqual([]);
    expect(groupsOf(groups, 'b').map((x) => x.id)).toEqual(['g1', 'g2']);
    expect(sortGroups(groups).map((x) => x.name)).toEqual(['Jefaturas', 'Terreno']);
  });
});
