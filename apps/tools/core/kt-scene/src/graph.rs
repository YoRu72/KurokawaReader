//! The scene's layer stack: drawn in FILE order (a composition — sky first, the near silhouettes last — not sorted by
//! depth), each with its depth (0 far … 1 near), parallax, opacity and the emitters drawn in it. Later pieces add a
//! transform, a parent and effect stacks per layer (the design record's data model).
//! Standalone: `rustc --edition 2021 --test src/graph.rs`.

#[derive(Clone, Debug, PartialEq)]
pub struct Layer {
    pub depth: f32,
    pub parallax: f32,
    pub opacity: f32,
    /// Indices of the scene's emitters drawn in this layer, in file order.
    pub emitters: Vec<usize>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Graph {
    pub layers: Vec<Layer>,
}

impl Graph {
    /// Layers from (depth, parallax, opacity), and each emitter's layer index (one out of range goes to layer 0).
    pub fn new(layers: &[(f32, f32, f32)], emitter_layers: &[usize]) -> Graph {
        let mut ls: Vec<Layer> = layers.iter().map(|&(d, p, o)| Layer { depth: d, parallax: p, opacity: o, emitters: Vec::new() }).collect();
        if ls.is_empty() {
            ls.push(Layer { depth: 0.5, parallax: 0.5, opacity: 1.0, emitters: Vec::new() });
        }
        for (e, &l) in emitter_layers.iter().enumerate() {
            let l = if l < ls.len() { l } else { 0 };
            ls[l].emitters.push(e);
        }
        Graph { layers: ls }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_order_and_emitters() {
        let g = Graph::new(&[(0.9, 0.9, 1.0), (0.1, 0.2, 0.5), (0.5, 0.5, 1.0)], &[0, 1, 2, 2, 99]);
        assert_eq!(g.layers[0].depth, 0.9);
        assert_eq!(g.layers[2].emitters, vec![2, 3]);
        assert_eq!(g.layers[0].emitters, vec![0, 4]);
        let empty = Graph::new(&[], &[0]);
        assert_eq!(empty.layers.len(), 1);
        assert_eq!(empty.layers[0].emitters, vec![0]);
    }
}
