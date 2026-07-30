# Broken LaTeX

Inline with an unbalanced brace $\frac{a}{$ should not crash anything.

$$
\begin{cases} x \\ y
$$ {#eq:broken}

Text continues normally after the broken block.
