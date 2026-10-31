export function createPermissionsService(repository) {
  return {
    async list() {
      const rows = await repository.findAll();
      return rows.map((row) => ({
        code: row.code,
        description: row.description,
        administrative: row.is_administrative,
      }));
    },
  };
}
