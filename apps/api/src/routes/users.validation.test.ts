import { describe, expect, it } from 'vitest';
import { inviteUserSchema, updateUserSchema } from './users';

describe('inviteUserSchema', () => {
  it('accepts a single-name user without a last name or role assignment', () => {
    const result = inviteUserSchema.parse({
      email: 'sam@example.com',
      firstName: 'Sam',
      lastName: '',
      phone: '9876543210',
      profileId: 'profile_123',
      roleIds: [],
    });

    expect(result.firstName).toBe('Sam');
    expect(result.lastName).toBe('');
    expect(result.roleIds).toEqual([]);
    expect(result.phone).toBe('9876543210');
  });

  it('rejects a user created without a phone', () => {
    const blank = inviteUserSchema.safeParse({
      email: 'sam@example.com',
      firstName: 'Sam',
      phone: '   ',
    });
    const missing = inviteUserSchema.safeParse({
      email: 'sam@example.com',
      firstName: 'Sam',
    });
    expect(blank.success).toBe(false);
    expect(missing.success).toBe(false);
    if (!blank.success) expect(blank.error.errors[0].message).toBe('Phone is required');
    if (!missing.success) expect(missing.error.errors[0].message).toBe('Phone is required');
  });
});

describe('updateUserSchema', () => {
  it('normalizes email addresses before persisting them', () => {
    expect(updateUserSchema.parse({ email: '  Sam@Example.COM  ' }).email).toBe('sam@example.com');
  });

  it('accepts a single-name user with a blank last name', () => {
    const result = updateUserSchema.parse({
      firstName: 'aadarsh',
      lastName: '',
      phone: '0989786576',
    });

    expect(result.firstName).toBe('aadarsh');
    expect(result.lastName).toBe('');
    expect(result.phone).toBe('0989786576');
  });
});
