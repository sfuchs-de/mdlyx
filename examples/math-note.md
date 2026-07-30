---
macros:
  RR: "\mathbb{R}"
numbering:
  equations: section
---
# A small mathematical note {#sec:intro}

For $x \in \RR$, define

$$
f(x) = x^2 + 1.
$$ {#eq:function}

Equation @eq:function is positive everywhere.

::: theorem {#thm:minimum}
The minimum of $f$ is one.
:::

::: proof
Since $x^2 \geq 0$, we have $f(x) \geq 1$, with equality at $x=0$.
:::
