using System.Globalization;
using Avalonia.Data.Converters;

namespace VideoMerge.Avalonia.Converters;

public sealed class IntDecimalConverter : IValueConverter
{
    public static readonly IntDecimalConverter Instance = new();

    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is int i ? (decimal)i : 0m;

    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value switch
        {
            decimal d => (int)d,
            double x => (int)x,
            int i => i,
            _ => 0,
        };
}

public sealed class DoubleDecimalConverter : IValueConverter
{
    public static readonly DoubleDecimalConverter Instance = new();

    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is double d ? (decimal)d : 0m;

    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value switch
        {
            decimal d => (double)d,
            double x => x,
            int i => (double)i,
            _ => 0d,
        };
}
