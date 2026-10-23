import { NativeSelect } from '@/components/ui/native-select';
import { useActiveCategories } from './use-categories';

/** "All categories" or one active category. Value is a category id or ''. */
export function CategoryFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (categoryId: string) => void;
}) {
  const categories = useActiveCategories();
  const options = categories.data ?? [];
  // A link can point at an inactive category, which is not in the list.
  const unknown = value && categories.isSuccess && !options.some((c) => c.id === value);

  return (
    <NativeSelect
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Category"
      className="w-full sm:w-52"
    >
      <option value="">All categories</option>
      {unknown && <option value={value}>Selected category</option>}
      {options.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </NativeSelect>
  );
}
