export function createPermissionsRepository(db) {
  return {
    async findAll() {
      const { rows } = await db.query(
        'SELECT code, description, is_administrative FROM permissions ORDER BY code',
      );
      return rows;
    },
  };
}
