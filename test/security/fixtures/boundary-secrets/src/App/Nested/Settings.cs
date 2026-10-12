namespace App.Nested;

public static class Settings
{
    public static string Describe(params object[] values) => string.Join(",", values.Select(v => v.GetType().Name));
}
